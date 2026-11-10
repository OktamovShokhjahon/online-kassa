#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Online Kass - cash desk program (Kassa desk).

One file, Python standard library only. It runs at the cash desk of one terminal of one shop:

  * reads a 2D / 1D barcode scanner plugged in by USB as a virtual COM port
    (a scanner in keyboard mode works too: the scan field always has the focus),
  * shows the scanned products, quantities, promotions and the total in a window,
  * writes every sale to the shop's database through the Online Kass API,
  * prints the receipt on an ESC/POS thermal printer (Windows printer, COM port or network),
  * needs no shift handling: the server opens one shift per day for the terminal and closes it
    the next day on its own, so the program just keeps selling,
  * keeps selling when the internet drops (shops without fiscal receipts) and sends the
    sales automatically when the connection is back.

The block between ">>> CONFIG" and "<<< CONFIG" was filled in by the Online Kass panel for one
terminal of one shop. The COM port, the printer and the language can be changed later in
Settings (button in the bottom bar); the changes are kept in
%LOCALAPPDATA%\\OnlineKassDesk\\<terminal>\\settings.json together with the log and unsent sales.

Run:            python kassa_desk.py
Build an .exe:  pip install pyinstaller pyserial
                pyinstaller --onefile --noconsole --name OnlineKassDesk kassa_desk.py
                -> dist\\OnlineKassDesk.exe  (pyserial is optional; without it the built-in
                   Windows COM driver is used)
Diagnostics:    python kassa_desk.py --check        (server, scanner ports, printers)
                python kassa_desk.py --test-print   (prints a test page)

Keys:  Enter - add the typed code   F9 - cash   F12 - card   F2 - quantity
       + / - - quantity of the selected line   Delete - remove line   Esc - clear receipt
"""
from __future__ import annotations

import ctypes
import json
import logging
import logging.handlers
import os
import queue
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

try:
    import tkinter as tk
    from tkinter import messagebox, ttk
except ImportError:  # --check works without Tk
    tk = None  # type: ignore

# >>> CONFIG
CONFIG = {
    "api_url": "",
    "api_key": "",
    "shop_name": "",
    "branch_name": "",
    "terminal_id": "",
    "terminal_name": "",
    "cashier_name": "",
    "currency": "UZS",
    "language": "uz",
    "fiscal": False,
    "scanner": {"port": "auto", "baudrate": 9600},
    "printer": {"type": "windows", "name": "", "port": "", "baudrate": 9600, "host": "", "tcp_port": 9100, "paper_mm": 58, "code_page": "CP866", "cut": False, "drawer": False},
}
# <<< CONFIG

VERSION = "1.0.0"
IS_WIN = sys.platform.startswith("win")
log = logging.getLogger("kassa_desk")


# ====================================================================== settings & files


def _merge(base, over):
    out = dict(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def data_dir() -> str:
    root = os.environ.get("LOCALAPPDATA") if IS_WIN else None
    root = root or os.path.join(os.path.expanduser("~"), ".local", "share")
    path = os.path.join(root, "OnlineKassDesk", CONFIG.get("terminal_id") or "default")
    os.makedirs(path, exist_ok=True)
    return path


def _path(name: str) -> str:
    return os.path.join(data_dir(), name)


def read_json(name: str, default):
    try:
        with open(_path(name), "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(name: str, value) -> None:
    tmp = _path(name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, indent=1)
    os.replace(tmp, _path(name))


def load_settings() -> dict:
    return _merge(CONFIG, read_json("settings.json", {}))


def save_settings(s: dict) -> None:
    write_json("settings.json", {k: s.get(k) for k in ("api_url", "api_key", "language", "scanner", "printer")})


def setup_logging() -> None:
    log.setLevel(logging.INFO)
    try:
        h = logging.handlers.RotatingFileHandler(_path("desk.log"), maxBytes=1_000_000, backupCount=3, encoding="utf-8")
        h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        log.addHandler(h)
    except OSError:
        pass
    if sys.stderr is not None:  # None in a --noconsole .exe
        log.addHandler(logging.StreamHandler())


# ============================================================================== texts

TEXT = {
    "en": {
        "today": "Today: {n} receipts · {sum}",
        "scan_hint": "Scan a barcode or type it and press Enter",
        "add": "Add", "col_name": "Product", "col_qty": "Qty", "col_price": "Price", "col_sum": "Sum",
        "to_pay": "To pay", "subtotal": "Subtotal", "discount": "Discount", "items": "Items",
        "cash": "Cash", "card": "Card", "clear": "Clear", "remove": "Remove", "qty": "Quantity",
        "given": "Cash given", "change": "Change", "exact": "Exact", "confirm": "Confirm", "cancel": "Cancel",
        "open_shift": "Open shift", "close_shift": "Close shift", "opening_cash": "Cash in the drawer at the start",
        "counted_cash": "Cash counted in the drawer", "expected_cash": "Expected cash", "x_report": "X-report",
        "settings": "Settings", "reprint": "Reprint", "online": "Online", "offline": "Offline",
        "scanner": "Scanner", "printer": "Printer", "not_connected": "not connected", "searching": "looking for the port",
        "keyboard": "keyboard mode",
        "not_found": "Product not found: {code}", "no_price": "{name} has no price in this branch",
        "scan_marking": "{name}: scan the DataMatrix marking code on the package",
        "marking_used": "This marking code is already in the receipt",
        "shift_none": "No open shift", "shift_open": "Shift open since {time}",
        "need_shift": "Open a shift to start selling", "queue": "Unsent: {n}",
        "last_receipt": "Receipt {n}", "sale_done": "Sale {number} saved", "printing_failed": "Printer error: {err}",
        "saved_offline": "No connection: the sale is kept on this computer and will be sent automatically",
        "weight_prompt": "Quantity of {name} ({unit})", "error": "Error",
        "test_print": "Test print", "save": "Save", "port": "Scanner COM port", "baud": "Speed (baud)", "auto": "auto",
        "printer_type": "Printer connection", "printer_name": "Windows printer", "printer_port": "Printer COM port",
        "host": "Printer IP address", "tcp_port": "TCP port",
        "paper": "Paper width, mm", "code_page": "Code page", "cut": "Cut the paper", "drawer": "Open the cash drawer",
        "language": "Language", "api_url": "Server address", "api_key": "Program key",
        "type_windows": "Windows printer (USB)", "type_serial": "COM port", "type_network": "Network (LAN)",
        "type_file": "Text file (test)", "type_none": "No printer", "port_none": "none (keyboard mode)",
        "closing_blocked": "{n} sale(s) are not sent yet. Connect to the internet and try again.",
        "cashier": "Cashier", "empty_cart": "Scan a product to start a receipt",
        "confirm_clear": "Remove all products from this receipt?",
        "not_configured": "This copy has no server address or key. Download the program again from the Programs tab of the shop, or fill them in Settings.",
        "card_confirm": "Charge {amount} on the card terminal, then press Confirm.",
        "insufficient": "Cash given is less than the total", "difference": "Difference",
        "saving": "Saving the sale…", "z_printed": "Shift closed. The Z-report is printed.", "settings_saved": "Settings saved",
        "fiscal_offline": "No connection to the server. Fiscal receipts need the internet.",
        "conn_error": "Cannot reach the server: {err}", "estimate": "promotions are applied when online",
        "printer_ok": "Test page sent to the printer", "shift_by": "Shift of {name}", "added": "{name}  {price}",
        "offline_receipt": "*** OFFLINE ***", "printed_to": "Printed to {target}", "quit_confirm": "The receipt is not finished. Close the program anyway?",
        "settings_hint": "Changes apply at once. The key is shown only in this window.",
        "history": "History",
        "history_title": "History of this cash desk",
        "h_all": "Everything",
        "h_sale": "Sales",
        "h_declined": "Declined",
        "h_refund": "Refunds",
        "h_arrival": "Goods received",
        "h_shift": "Shifts",
        "h_cash": "Cash in/out",
        "p_today": "Today",
        "p_yesterday": "Yesterday",
        "p_7d": "Last 7 days",
        "p_30d": "Last 30 days",
        "p_all": "All time",
        "find": "Find",
        "load_more": "Show more",
        "refresh": "Refresh",
        "period": "Period",
        "search_hint": "Number or product",
        "col_time": "Time",
        "col_type": "Type",
        "col_number": "No",
        "col_details": "Details",
        "col_amount": "Amount",
        "col_status": "Status",
        "st_completed": "approved",
        "st_partially_refunded": "partly refunded",
        "st_refunded": "refunded",
        "st_cleared": "cleared by cashier",
        "st_rejected": "refused: {code}",
        "st_posted": "received",
        "st_cancelled": "cancelled",
        "st_open": "shift opened",
        "st_close": "shift closed",
        "st_in": "cash in",
        "st_out": "cash out",
        "st_pending": "waiting to be sent",
        "h_offline": "No connection: only the sales waiting on this computer are shown.",
        "h_empty": "Nothing found for this filter.",
        "h_summary": "Sales: {s} ({sa})   Declined: {d}   Refunds: {r}   Goods received: {a}",
        "h_shown": "Shown {n} of {total}",
        "details": "Details",
        "print_again": "Print again",
        "no_supplier": "supplier not set",
        "from_supplier": "from {name}",
        "h_loading": "Loading…",
        "r_sale": "Sale",
        "r_declined": "Declined",
        "r_refund": "Refund",
        "r_arrival": "Goods received",
        "r_shift": "Shift",
        "r_cash": "Cash",
    },
    "ru": {
        "today": "Сегодня: {n} чеков · {sum}",
        "scan_hint": "Отсканируйте штрихкод или введите его и нажмите Enter",
        "add": "Добавить", "col_name": "Товар", "col_qty": "Кол-во", "col_price": "Цена", "col_sum": "Сумма",
        "to_pay": "К оплате", "subtotal": "Без скидки", "discount": "Скидка", "items": "Позиций",
        "cash": "Наличные", "card": "Карта", "clear": "Очистить", "remove": "Удалить", "qty": "Количество",
        "given": "Получено наличными", "change": "Сдача", "exact": "Без сдачи", "confirm": "Подтвердить", "cancel": "Отмена",
        "open_shift": "Открыть смену", "close_shift": "Закрыть смену", "opening_cash": "Наличные в кассе на начало",
        "counted_cash": "Пересчитано наличных", "expected_cash": "Ожидается наличных", "x_report": "X-отчёт",
        "settings": "Настройки", "reprint": "Повтор чека", "online": "В сети", "offline": "Нет связи",
        "scanner": "Сканер", "printer": "Принтер", "not_connected": "не подключён", "searching": "поиск порта",
        "keyboard": "режим клавиатуры",
        "not_found": "Товар не найден: {code}", "no_price": "У товара {name} нет цены в этом филиале",
        "scan_marking": "{name}: отсканируйте код маркировки DataMatrix на упаковке",
        "marking_used": "Этот код маркировки уже есть в чеке",
        "shift_none": "Смена не открыта", "shift_open": "Смена открыта с {time}",
        "need_shift": "Откройте смену, чтобы продавать", "queue": "Не отправлено: {n}",
        "last_receipt": "Чек {n}", "sale_done": "Продажа {number} сохранена", "printing_failed": "Ошибка принтера: {err}",
        "saved_offline": "Нет связи: продажа сохранена на этом компьютере и будет отправлена автоматически",
        "weight_prompt": "Количество: {name} ({unit})", "error": "Ошибка",
        "test_print": "Тестовая печать", "save": "Сохранить", "port": "COM-порт сканера", "baud": "Скорость (бод)", "auto": "авто",
        "printer_type": "Подключение принтера", "printer_name": "Принтер Windows", "printer_port": "COM-порт принтера",
        "host": "IP-адрес принтера", "tcp_port": "TCP-порт",
        "paper": "Ширина бумаги, мм", "code_page": "Кодовая страница", "cut": "Отрезать бумагу", "drawer": "Открывать денежный ящик",
        "language": "Язык", "api_url": "Адрес сервера", "api_key": "Ключ программы",
        "type_windows": "Принтер Windows (USB)", "type_serial": "COM-порт", "type_network": "Сеть (LAN)",
        "type_file": "Текстовый файл (тест)", "type_none": "Без принтера", "port_none": "нет (режим клавиатуры)",
        "closing_blocked": "Не отправлено продаж: {n}. Подключитесь к интернету и повторите.",
        "cashier": "Кассир", "empty_cart": "Отсканируйте товар, чтобы начать чек",
        "confirm_clear": "Убрать все товары из этого чека?",
        "not_configured": "В этой копии нет адреса сервера или ключа. Скачайте программу заново на вкладке «Программы» магазина или заполните их в настройках.",
        "card_confirm": "Проведите {amount} на терминале и нажмите «Подтвердить».",
        "insufficient": "Получено меньше суммы чека", "difference": "Разница",
        "saving": "Сохраняем продажу…", "z_printed": "Смена закрыта. Z-отчёт напечатан.", "settings_saved": "Настройки сохранены",
        "fiscal_offline": "Нет связи с сервером. Фискальным чекам нужен интернет.",
        "conn_error": "Сервер недоступен: {err}", "estimate": "акции применяются при подключении",
        "printer_ok": "Тестовая страница отправлена на принтер", "shift_by": "Смена: {name}", "added": "{name}  {price}",
        "offline_receipt": "*** БЕЗ СВЯЗИ ***", "printed_to": "Напечатано: {target}", "quit_confirm": "Чек не завершён. Всё равно закрыть программу?",
        "settings_hint": "Изменения применяются сразу. Ключ виден только в этом окне.",
        "history": "История",
        "history_title": "История этой кассы",
        "h_all": "Всё",
        "h_sale": "Продажи",
        "h_declined": "Отклонённые",
        "h_refund": "Возвраты",
        "h_arrival": "Приход товара",
        "h_shift": "Смены",
        "h_cash": "Внесение/изъятие",
        "p_today": "Сегодня",
        "p_yesterday": "Вчера",
        "p_7d": "Последние 7 дней",
        "p_30d": "Последние 30 дней",
        "p_all": "Всё время",
        "find": "Найти",
        "load_more": "Показать ещё",
        "refresh": "Обновить",
        "period": "Период",
        "search_hint": "Номер или товар",
        "col_time": "Время",
        "col_type": "Тип",
        "col_number": "№",
        "col_details": "Подробно",
        "col_amount": "Сумма",
        "col_status": "Статус",
        "st_completed": "принят",
        "st_partially_refunded": "частичный возврат",
        "st_refunded": "возвращён",
        "st_cleared": "очищен кассиром",
        "st_rejected": "отказ: {code}",
        "st_posted": "принят",
        "st_cancelled": "отменён",
        "st_open": "смена открыта",
        "st_close": "смена закрыта",
        "st_in": "внесение",
        "st_out": "изъятие",
        "st_pending": "ждёт отправки",
        "h_offline": "Нет связи: показаны только продажи, ожидающие отправки на этом компьютере.",
        "h_empty": "По этому фильтру ничего нет.",
        "h_summary": "Продажи: {s} ({sa})   Отклонённые: {d}   Возвраты: {r}   Приходы: {a}",
        "h_shown": "Показано {n} из {total}",
        "details": "Подробно",
        "print_again": "Напечатать снова",
        "no_supplier": "поставщик не указан",
        "from_supplier": "от {name}",
        "h_loading": "Загрузка…",
        "r_sale": "Продажа",
        "r_declined": "Отклонён",
        "r_refund": "Возврат",
        "r_arrival": "Приход",
        "r_shift": "Смена",
        "r_cash": "Деньги",
    },
    "uz": {
        "today": "Bugun: {n} ta chek · {sum}",
        "scan_hint": "Shtrix-kodni skanerlang yoki yozib Enter bosing",
        "add": "Qo'shish", "col_name": "Mahsulot", "col_qty": "Soni", "col_price": "Narx", "col_sum": "Summa",
        "to_pay": "To'lov", "subtotal": "Chegirmasiz", "discount": "Chegirma", "items": "Pozitsiya",
        "cash": "Naqd", "card": "Karta", "clear": "Tozalash", "remove": "O'chirish", "qty": "Miqdor",
        "given": "Berilgan naqd pul", "change": "Qaytim", "exact": "Qaytimsiz", "confirm": "Tasdiqlash", "cancel": "Bekor qilish",
        "open_shift": "Smenani ochish", "close_shift": "Smenani yopish", "opening_cash": "Smena boshidagi naqd pul",
        "counted_cash": "Kassada sanalgan naqd pul", "expected_cash": "Kutilgan naqd pul", "x_report": "X-hisobot",
        "settings": "Sozlamalar", "reprint": "Qayta chop", "online": "Onlayn", "offline": "Aloqa yo'q",
        "scanner": "Skaner", "printer": "Printer", "not_connected": "ulanmagan", "searching": "port qidirilmoqda",
        "keyboard": "klaviatura rejimi",
        "not_found": "Mahsulot topilmadi: {code}", "no_price": "{name} uchun bu filialda narx yo'q",
        "scan_marking": "{name}: qadoqdagi DataMatrix markirovka kodini skanerlang",
        "marking_used": "Bu markirovka kodi chekda allaqachon bor",
        "shift_none": "Smena ochilmagan", "shift_open": "Smena {time} dan ochiq",
        "need_shift": "Sotish uchun smenani oching", "queue": "Yuborilmagan: {n}",
        "last_receipt": "Chek {n}", "sale_done": "{number} savdo saqlandi", "printing_failed": "Printer xatosi: {err}",
        "saved_offline": "Aloqa yo'q: savdo shu kompyuterda saqlandi va avtomatik yuboriladi",
        "weight_prompt": "{name} miqdori ({unit})", "error": "Xato",
        "test_print": "Sinov chop", "save": "Saqlash", "port": "Skaner COM porti", "baud": "Tezlik (bod)", "auto": "avto",
        "printer_type": "Printer ulanishi", "printer_name": "Windows printeri", "printer_port": "Printer COM porti",
        "host": "Printer IP manzili", "tcp_port": "TCP port",
        "paper": "Qog'oz kengligi, mm", "code_page": "Kod sahifasi", "cut": "Qog'ozni kesish", "drawer": "Pul qutisini ochish",
        "language": "Til", "api_url": "Server manzili", "api_key": "Dastur kaliti",
        "type_windows": "Windows printeri (USB)", "type_serial": "COM port", "type_network": "Tarmoq (LAN)",
        "type_file": "Matn fayli (sinov)", "type_none": "Printersiz", "port_none": "yo'q (klaviatura rejimi)",
        "closing_blocked": "{n} ta savdo hali yuborilmagan. Internetga ulanib, qayta urinib ko'ring.",
        "cashier": "Kassir", "empty_cart": "Chekni boshlash uchun mahsulotni skanerlang",
        "confirm_clear": "Chekdagi barcha mahsulotlar olib tashlansinmi?",
        "not_configured": "Bu nusxada server manzili yoki kaliti yo'q. Dasturni do'konning «Dasturlar» bo'limidan qayta yuklab oling yoki sozlamalarda to'ldiring.",
        "card_confirm": "Terminalda {amount} o'tkazing, so'ng «Tasdiqlash» ni bosing.",
        "insufficient": "Berilgan pul chek summasidan kam", "difference": "Farq",
        "saving": "Savdo saqlanmoqda…", "z_printed": "Smena yopildi. Z-hisobot chop etildi.", "settings_saved": "Sozlamalar saqlandi",
        "fiscal_offline": "Server bilan aloqa yo'q. Fiskal cheklar uchun internet kerak.",
        "conn_error": "Serverga ulanib bo'lmadi: {err}", "estimate": "aksiyalar onlayn qo'llanadi",
        "printer_ok": "Sinov sahifasi printerga yuborildi", "shift_by": "Smena: {name}", "added": "{name}  {price}",
        "offline_receipt": "*** OFLAYN ***", "printed_to": "Chop etildi: {target}", "quit_confirm": "Chek tugallanmagan. Baribir dasturni yopasizmi?",
        "settings_hint": "O'zgarishlar darhol qo'llanadi. Kalit faqat shu oynada ko'rinadi.",
        "history": "Tarix",
        "history_title": "Shu kassa tarixi",
        "h_all": "Hammasi",
        "h_sale": "Sotuvlar",
        "h_declined": "Rad etilganlar",
        "h_refund": "Qaytarishlar",
        "h_arrival": "Kelgan mahsulotlar",
        "h_shift": "Smenalar",
        "h_cash": "Kirim/chiqim pul",
        "p_today": "Bugun",
        "p_yesterday": "Kecha",
        "p_7d": "Oxirgi 7 kun",
        "p_30d": "Oxirgi 30 kun",
        "p_all": "Hammasi",
        "find": "Topish",
        "load_more": "Yana ko'rsatish",
        "refresh": "Yangilash",
        "period": "Davr",
        "search_hint": "Raqam yoki mahsulot",
        "col_time": "Vaqt",
        "col_type": "Turi",
        "col_number": "Raqam",
        "col_details": "Tafsilot",
        "col_amount": "Summa",
        "col_status": "Holat",
        "st_completed": "tasdiqlangan",
        "st_partially_refunded": "qisman qaytarilgan",
        "st_refunded": "qaytarilgan",
        "st_cleared": "kassir tozalagan",
        "st_rejected": "rad etildi: {code}",
        "st_posted": "qabul qilingan",
        "st_cancelled": "bekor qilingan",
        "st_open": "smena ochildi",
        "st_close": "smena yopildi",
        "st_in": "pul kiritildi",
        "st_out": "pul olindi",
        "st_pending": "yuborilishini kutmoqda",
        "h_offline": "Aloqa yo'q: faqat shu kompyuterda yuborilishini kutayotgan savdolar ko'rsatilgan.",
        "h_empty": "Bu filtr bo'yicha hech narsa topilmadi.",
        "h_summary": "Sotuvlar: {s} ({sa})   Rad etilgan: {d}   Qaytarishlar: {r}   Kirimlar: {a}",
        "h_shown": "{total} tadan {n} tasi ko'rsatilgan",
        "details": "Tafsilot",
        "print_again": "Qayta chop etish",
        "no_supplier": "yetkazib beruvchi ko'rsatilmagan",
        "from_supplier": "{name} dan",
        "h_loading": "Yuklanmoqda…",
        "r_sale": "Sotuv",
        "r_declined": "Rad etilgan",
        "r_refund": "Qaytarish",
        "r_arrival": "Kirim",
        "r_shift": "Smena",
        "r_cash": "Pul",
    },
}

# Receipt labels for receipts printed without the server (offline sales and the test page).
RECEIPT_LABELS = {
    "en": {"receipt": "RECEIPT", "number": "No", "date": "Date", "cashier": "Cashier", "terminal": "Terminal", "subtotal": "Subtotal", "discount": "Discount", "total": "TOTAL", "cash": "Cash", "card": "Card", "cashGiven": "Cash given", "change": "Change", "thanks": "Thank you for your purchase!"},
    "ru": {"receipt": "ЧЕК", "number": "№", "date": "Дата", "cashier": "Кассир", "terminal": "Касса", "subtotal": "Без скидки", "discount": "Скидка", "total": "ИТОГО", "cash": "Наличные", "card": "Карта", "cashGiven": "Получено", "change": "Сдача", "thanks": "Спасибо за покупку!"},
    "uz": {"receipt": "CHEK", "number": "No", "date": "Sana", "cashier": "Kassir", "terminal": "Kassa", "subtotal": "Chegirmasiz", "discount": "Chegirma", "total": "JAMI", "cash": "Naqd", "card": "Karta", "cashGiven": "Berildi", "change": "Qaytim", "thanks": "Xaridingiz uchun rahmat!"},
}

LANG = "uz"


def set_language(lang) -> None:
    global LANG
    LANG = lang if lang in TEXT else "uz"


def tr(key: str, **kw) -> str:
    s = TEXT.get(LANG, TEXT["en"]).get(key) or TEXT["en"].get(key, key)
    return s.format(**kw) if kw else s


# ============================================================================== money

CUR_SUFFIX = {"UZS": {"uz": "so'm", "ru": "сум", "en": "UZS"}, "USD": {"uz": "USD", "ru": "USD", "en": "USD"}, "RUB": {"uz": "RUB", "ru": "руб", "en": "RUB"}}


def fmt_amount(minor: int, cur: str = "UZS") -> str:
    """Minor units (tiyin / cents) -> `12 500` for UZS, `12.50` for USD and RUB."""
    neg = minor < 0
    major = Decimal(abs(int(minor))) / 100
    body = str(major.quantize(Decimal("1"), ROUND_HALF_UP)) if cur == "UZS" else str(major.quantize(Decimal("0.01"), ROUND_HALF_UP))
    i, _, f = body.partition(".")
    grouped = "{:,}".format(int(i)).replace(",", " ")
    return ("-" if neg else "") + grouped + ("." + f if f else "")


def fmt_money(minor: int, cur: str = "UZS") -> str:
    return "%s %s" % (fmt_amount(minor, cur), CUR_SUFFIX.get(cur, {}).get(LANG, cur))


def parse_money(text: str):
    """`50 000` / `12,5` -> minor units, or None."""
    t = (text or "").replace(" ", "").replace(" ", "").replace(",", ".")
    if not t:
        return None
    try:
        v = Decimal(t)
    except InvalidOperation:
        return None
    if v < 0:
        return None
    return int((v * 100).quantize(Decimal("1"), ROUND_HALF_UP))


def fmt_qty(q: float) -> str:
    return str(int(q)) if float(q).is_integer() else ("%.3f" % q).rstrip("0").rstrip(".")


def line_gross(qty: float, price: int) -> int:
    return int((Decimal(str(qty)) * price).quantize(Decimal("1"), ROUND_HALF_UP))


# ============================================================================ ESC/POS

CODE_PAGE_NUMBER = {"CP437": 0, "WPC1252": 16, "CP866": 17, "CP1251": 46}
PY_CODEC = {"CP437": "cp437", "WPC1252": "cp1252", "CP866": "cp866", "CP1251": "cp1251"}
_NORMALIZE = {ord(c): "'" for c in "‘’ʻʼʽ`´′ʹ"}
_NORMALIZE.update({ord(c): '"' for c in "“”«»"})
_NORMALIZE.update({0x2013: "-", 0x2014: "-", 0x2026: "...", 0x00A0: " "})
ESC, GS = 0x1B, 0x1D


def normalize_text(s: str) -> str:
    """Uzbek o' g' and similar signs are printed with the ASCII apostrophe (printers lack the glyphs)."""
    s = (s or "").translate(_NORMALIZE)
    return "".join(" " if (ord(ch) < 32 and ch != "\n") else ch for ch in s)


def wrap_text(text: str, width: int) -> list:
    out = []
    for para in normalize_text(text).split("\n"):
        line = ""
        for word in para.split():
            while len(word) > width:
                if line:
                    out.append(line)
                    line = ""
                out.append(word[:width])
                word = word[width:]
            if not line:
                line = word
            elif len(line) + 1 + len(word) <= width:
                line += " " + word
            else:
                out.append(line)
                line = word
        out.append(line)
    return out


def two_columns(left: str, right: str, width: int) -> str:
    left, right = normalize_text(left), normalize_text(right)
    room = width - len(right) - 1
    lt = left[: max(0, room)] if len(left) > room else left
    return lt + " " * max(1, width - len(lt) - len(right)) + right


class EscPos:
    """Minimal ESC/POS document. `preview` mirrors the printed text (used by the 'text file' printer)."""

    def __init__(self, printer: dict):
        self.width = 48 if int(printer.get("paper_mm") or 58) >= 80 else 32
        cp = printer.get("code_page") or "CP866"
        self.codec = PY_CODEC.get(cp, "cp866")
        self.chunks = []
        self.preview = []
        self.raw(ESC, 0x40)  # initialize
        self.raw(ESC, 0x74, CODE_PAGE_NUMBER.get(cp, 17))  # character code table

    def raw(self, *b):
        self.chunks.append(bytes(b))
        return self

    def align(self, a):
        return self.raw(ESC, 0x61, {"left": 0, "center": 1, "right": 2}[a])

    def bold(self, on):
        return self.raw(ESC, 0x45, 1 if on else 0)

    def size(self, w, h):
        return self.raw(GS, 0x21, ((w - 1) << 4) | (h - 1))

    def line(self, text=""):
        self.preview.append(text)
        self.chunks.append(normalize_text(text).encode(self.codec, errors="replace") + b"\n")
        return self

    def lines(self, text, align="left"):
        self.align(align)
        for l in wrap_text(text, self.width):
            self.line(l)
        return self.align("left")

    def sep(self, ch="-"):
        return self.line(ch * self.width)

    def row(self, left, right):
        return self.line(two_columns(left, right, self.width))

    def center(self, text):
        self.align("center")
        self.line(normalize_text(text)[: self.width])
        return self.align("left")

    def feed(self, n=3):
        self.preview.extend([""] * n)
        return self.raw(ESC, 0x64, n)

    def cut(self):
        return self.raw(GS, 0x56, 0x42, 0x00)

    def open_drawer(self):
        return self.raw(ESC, 0x70, 0x00, 0x19, 0xFA)

    def qr(self, data, size=6):
        b = data.encode("utf-8")
        n = len(b) + 3
        self.align("center")
        self.raw(GS, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00)  # model 2
        self.raw(GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, max(1, min(16, size)))  # module size
        self.raw(GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, 0x31)  # error correction M
        self.raw(GS, 0x28, 0x6B, n & 0xFF, (n >> 8) & 0xFF, 0x31, 0x50, 0x30)
        self.chunks.append(b)
        self.raw(GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30)  # print
        self.preview.append("[QR %s]" % (data if len(data) <= 40 else data[:40] + "..."))
        return self.align("left")

    def data(self) -> bytes:
        return b"".join(self.chunks)


def _with_cur(minor, cur, lang):
    return "%s %s" % (fmt_amount(minor, cur), CUR_SUFFIX.get(cur, {}).get(lang, cur))


def render_receipt(r: dict, printer: dict) -> EscPos:
    """Sale receipt from the structured data the server returns (same layout as the Online Kass agent)."""
    p = EscPos(printer)
    L = r.get("labels") or {}
    cur = r.get("currency") or "UZS"
    lang = r.get("language") or LANG
    if printer.get("drawer") and any(x.get("method") == "cash" and x.get("amount", 0) > 0 for x in r.get("payments", [])):
        p.open_drawer()  # opens while the receipt is still printing
    if r.get("copy"):
        p.center(L.get("copy", "*** COPY ***"))
    p.align("center").bold(True).size(2, 2)
    for l in wrap_text((r.get("shop") or {}).get("name", ""), p.width // 2):
        p.line(l)
    p.size(1, 1).bold(False).align("left")
    br = r.get("branch") or {}
    for key in ("name", "address", "phone"):
        if br.get(key):
            p.lines(br[key], "center")
    if (r.get("shop") or {}).get("tin"):
        p.lines("%s: %s" % (L.get("tin", "TIN"), r["shop"]["tin"]), "center")
    if r.get("header"):
        p.lines(r["header"], "center")
    p.sep()
    p.bold(True).center(L.get("receipt", "RECEIPT")).bold(False)
    p.row(L.get("number", "No") + ":", r.get("number", ""))
    p.row(L.get("date", "Date") + ":", r.get("createdAt", ""))
    if r.get("cashier"):
        p.row(L.get("cashier", "Cashier") + ":", r["cashier"])
    if r.get("terminal"):
        p.row(L.get("terminal", "Terminal") + ":", r["terminal"])
    if r.get("customer"):
        p.lines("%s: %s %s" % (L.get("customer", "Customer"), r["customer"].get("name", ""), r["customer"].get("phone", "")))
    p.sep()
    for l in r.get("lines", []):
        for n in wrap_text(l.get("name", ""), p.width)[:2]:
            p.line(n)
        p.row("  %s x %s" % (fmt_qty(l.get("qty", 1)), fmt_amount(l.get("price", 0), cur)), fmt_amount(line_gross(l.get("qty", 1), l.get("price", 0)), cur))
        if l.get("discount", 0) > 0:
            label = "%s: %s" % (L.get("promotion", "Promo"), l["promotion"]) if l.get("promotion") else L.get("discount", "Discount")
            p.row("  " + label, "-" + fmt_amount(l["discount"], cur))
            p.row("", fmt_amount(l.get("total", 0), cur))
        if l.get("mxikCode"):
            p.line("  %s %s" % (L.get("mxik", "MXIK"), l["mxikCode"]))
    p.sep()
    if r.get("discount", 0) > 0:
        p.row(L.get("subtotal", "Subtotal"), fmt_amount(r.get("subtotal", 0), cur))
        p.row(L.get("discount", "Discount"), "-" + fmt_amount(r["discount"], cur))
    for v in r.get("vat") or []:
        p.row("%s %s%%" % (L.get("vat", "VAT"), v.get("rate")), fmt_amount(v.get("amount", 0), cur))
    p.bold(True).size(1, 2)
    p.row(L.get("total", "TOTAL"), _with_cur(r.get("total", 0), cur, lang))
    p.size(1, 1).bold(False)
    p.sep()
    for pay in r.get("payments", []):
        p.row(pay.get("label") or L.get(pay.get("method"), pay.get("method", "")), fmt_amount(pay.get("amount", 0), cur))
    if (r.get("cashGiven") or 0) > 0 and (r.get("change") or 0) > 0:
        p.row(L.get("cashGiven", "Given"), fmt_amount(r["cashGiven"], cur))
        p.row(L.get("change", "Change"), fmt_amount(r["change"], cur))
    if r.get("customer") and (r.get("bonusEarned") or 0) > 0:
        p.row(L.get("bonusEarned", "Bonus earned"), fmt_amount(r["bonusEarned"], cur))
    fiscal = r.get("fiscal") or {}
    if fiscal.get("sign"):
        p.sep()
        p.lines("%s: %s" % (L.get("fiscalSign", "Fiscal sign"), fiscal["sign"]))
        if fiscal.get("moduleId"):
            p.lines("%s: %s" % (L.get("fiscalModule", "Fiscal module"), fiscal["moduleId"]))
        if fiscal.get("receiptId"):
            p.lines("%s: %s" % (L.get("fiscalReceipt", "Receipt"), fiscal["receiptId"]))
        if fiscal.get("qr"):
            p.qr(fiscal["qr"], 5)
    p.sep()
    if L.get("thanks"):
        p.center(L["thanks"])
    if r.get("footer"):
        p.lines(r["footer"], "center")
    if r.get("qr"):
        p.qr(r["qr"], 6)
    p.feed(4 if printer.get("cut") else 5)
    if printer.get("cut"):
        p.cut()
    return p


def render_report(r: dict, printer: dict) -> EscPos:
    """X-report (shift totals) or Z-report (closing)."""
    p = EscPos(printer)
    L = r.get("labels") or {}
    cur = r.get("currency") or "UZS"
    t = r.get("totals") or {}
    bm = t.get("byMethod") or {}
    rf = t.get("refunds") or {}
    p.align("center").bold(True).size(2, 1).line(normalize_text((r.get("shop") or {}).get("name", ""))[: p.width // 2]).size(1, 1)
    p.line(L.get("zReport", "Z-REPORT") if r.get("type") == "z_report" else L.get("xReport", "X-REPORT")).bold(False).align("left")
    if (r.get("branch") or {}).get("name"):
        p.lines(r["branch"]["name"], "center")
    p.sep()
    if r.get("terminal"):
        p.row(L.get("terminal", "Terminal") + ":", r["terminal"])
    if r.get("cashier"):
        p.row(L.get("cashier", "Cashier") + ":", r["cashier"])
    p.row(L.get("opened", "Opened") + ":", r.get("openedAt", ""))
    if r.get("closedAt"):
        p.row(L.get("closed", "Closed") + ":", r["closedAt"])
    p.sep()
    p.row(L.get("receipts", "Receipts"), str(t.get("receipts", 0)))
    p.row(L.get("sales", "Sales"), fmt_amount(t.get("net", 0), cur))
    if t.get("discount", 0) > 0:
        p.row(L.get("discount", "Discount"), fmt_amount(t["discount"], cur))
    p.row(L.get("cash", "Cash"), fmt_amount(bm.get("cash", 0), cur))
    p.row(L.get("card", "Card"), fmt_amount(bm.get("card", 0), cur))
    if bm.get("bonus"):
        p.row(L.get("bonus", "Bonus"), fmt_amount(bm["bonus"], cur))
    if bm.get("credit"):
        p.row(L.get("credit", "Credit"), fmt_amount(bm["credit"], cur))
    if rf.get("count"):
        p.row("%s (%s)" % (L.get("returns", "Returns"), rf["count"]), "-" + fmt_amount(rf.get("total", 0), cur))
    p.sep()
    p.row(L.get("openingCash", "Opening cash"), fmt_amount(t.get("openingCash", 0), cur))
    if t.get("cashIn"):
        p.row(L.get("cashIn", "Cash in"), fmt_amount(t["cashIn"], cur))
    if t.get("cashOut"):
        p.row(L.get("cashOut", "Cash out"), "-" + fmt_amount(t["cashOut"], cur))
    p.bold(True).row(L.get("expectedCash", "Expected cash"), fmt_amount(t.get("expectedCash", 0), cur)).bold(False)
    if r.get("countedCash") is not None:
        p.row(L.get("countedCash", "Counted cash"), fmt_amount(r["countedCash"], cur))
        p.bold(True).row(L.get("difference", "Difference"), fmt_amount(r.get("difference") or 0, cur)).bold(False)
    p.feed(4 if printer.get("cut") else 5)
    if printer.get("cut"):
        p.cut()
    return p


def render_test_page(printer: dict, settings: dict) -> EscPos:
    p = EscPos(printer)
    p.center("ONLINE KASS").center("TEST / ТЕСТ / SINOV")
    p.sep("=")
    p.line(("0123456789" * 5)[: p.width])
    p.line("ABCDEFGHIJKLMNOPQRSTUVWXYZ"[: p.width])
    p.line("АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ"[: p.width])
    p.line("O'zbekiston g'alaba o'g'il"[: p.width])
    p.sep("=")
    p.row("Width:", "%d chars" % p.width)
    if settings.get("terminal_name"):
        p.row("Terminal:", settings["terminal_name"])
    p.row("Program:", VERSION)
    p.qr("ONLINE-KASS-TEST", 5)
    p.feed(4 if printer.get("cut") else 5)
    if printer.get("cut"):
        p.cut()
    return p


# ======================================================================== COM ports


class SerialPort:
    """A COM port: pyserial when it is installed, otherwise the Win32 API through ctypes."""

    def __init__(self, port: str, baudrate: int = 9600, timeout: float = 0.2):
        self.port = port
        self._ser = None
        self._h = None
        try:
            import serial  # type: ignore

            try:
                self._ser = serial.Serial(port, int(baudrate), timeout=timeout, write_timeout=3)
            except serial.SerialException as e:
                raise OSError(str(e))
            return
        except ImportError:
            pass
        if not IS_WIN:
            raise OSError("pyserial is needed for COM ports on this system: pip install pyserial")
        self._open_win(port, int(baudrate), timeout)

    def _open_win(self, port, baudrate, timeout):
        from ctypes import wintypes

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CreateFileW.restype = wintypes.HANDLE
        k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        for fn in ("SetupComm", "GetCommState", "SetCommState", "SetCommTimeouts", "ReadFile", "WriteFile", "CloseHandle", "PurgeComm"):
            getattr(k32, fn).restype = wintypes.BOOL

        class DCB(ctypes.Structure):
            _fields_ = [
                ("DCBlength", wintypes.DWORD), ("BaudRate", wintypes.DWORD), ("fBits", wintypes.DWORD),
                ("wReserved", wintypes.WORD), ("XonLim", wintypes.WORD), ("XoffLim", wintypes.WORD),
                ("ByteSize", ctypes.c_ubyte), ("Parity", ctypes.c_ubyte), ("StopBits", ctypes.c_ubyte),
                ("XonChar", ctypes.c_char), ("XoffChar", ctypes.c_char), ("ErrorChar", ctypes.c_char),
                ("EofChar", ctypes.c_char), ("EvtChar", ctypes.c_char), ("wReserved1", wintypes.WORD),
            ]

        class COMMTIMEOUTS(ctypes.Structure):
            _fields_ = [(n, wintypes.DWORD) for n in ("ReadIntervalTimeout", "ReadTotalTimeoutMultiplier", "ReadTotalTimeoutConstant", "WriteTotalTimeoutMultiplier", "WriteTotalTimeoutConstant")]

        h = k32.CreateFileW("\\\\.\\" + port, 0x80000000 | 0x40000000, 0, None, 3, 0, None)
        if h is None or h == wintypes.HANDLE(-1).value:
            raise OSError("cannot open %s (error %d)" % (port, ctypes.get_last_error()))
        self._k32, self._h = k32, h
        k32.SetupComm(h, 4096, 4096)
        dcb = DCB()
        dcb.DCBlength = ctypes.sizeof(DCB)
        if not k32.GetCommState(h, ctypes.byref(dcb)):
            self.close()
            raise OSError("cannot read the settings of %s" % port)
        dcb.BaudRate = baudrate
        dcb.ByteSize, dcb.Parity, dcb.StopBits = 8, 0, 0
        dcb.fBits = 0x0001 | (1 << 4) | (1 << 12)  # binary, DTR on, RTS on
        if not k32.SetCommState(h, ctypes.byref(dcb)):
            self.close()
            raise OSError("cannot configure %s" % port)
        to = COMMTIMEOUTS(0xFFFFFFFF, 0xFFFFFFFF, max(1, int(timeout * 1000)), 0, 3000)
        k32.SetCommTimeouts(h, ctypes.byref(to))
        k32.PurgeComm(h, 0x0008 | 0x0004)  # clear stale input / output

    def read(self, n: int = 256) -> bytes:
        if self._ser is not None:
            return self._ser.read(n)
        from ctypes import wintypes

        buf = ctypes.create_string_buffer(n)
        got = wintypes.DWORD(0)
        if not self._k32.ReadFile(self._h, buf, n, ctypes.byref(got), None):
            raise OSError("read from %s failed (error %d)" % (self.port, ctypes.get_last_error()))
        return buf.raw[: got.value]

    def write(self, data: bytes) -> None:
        if self._ser is not None:
            self._ser.write(data)
            self._ser.flush()
            return
        from ctypes import wintypes

        sent = 0
        while sent < len(data):
            chunk = data[sent:]
            done = wintypes.DWORD(0)
            if not self._k32.WriteFile(self._h, chunk, len(chunk), ctypes.byref(done), None) or done.value == 0:
                raise OSError("write to %s failed (error %d)" % (self.port, ctypes.get_last_error()))
            sent += done.value

    def close(self) -> None:
        try:
            if self._ser is not None:
                self._ser.close()
            elif self._h is not None:
                self._k32.CloseHandle(self._h)
        except Exception:
            pass
        self._ser = None
        self._h = None


def list_com_ports() -> list:
    """[(port, description)] of the COM ports that exist now."""
    try:
        from serial.tools import list_ports  # type: ignore

        return sorted(((p.device, p.description or "") for p in list_ports.comports()), key=lambda x: _port_key(x[0]))
    except ImportError:
        pass
    ports = []
    if IS_WIN:
        try:
            import winreg

            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DEVICEMAP\SERIALCOMM") as k:
                i = 0
                while True:
                    try:
                        dev, name, _ = winreg.EnumValue(k, i)
                    except OSError:
                        break
                    ports.append((str(name), str(dev).split("\\")[-1]))
                    i += 1
        except OSError:
            pass
    return sorted(ports, key=lambda x: _port_key(x[0]))


def _port_key(name: str):
    digits = "".join(c for c in name if c.isdigit())
    return (int(digits) if digits else 0, name)


# ========================================================================== printers


class PrinterError(Exception):
    pass


def windows_printers() -> list:
    if not IS_WIN:
        return []
    from ctypes import wintypes

    class PRINTER_INFO_4(ctypes.Structure):
        _fields_ = [("pPrinterName", wintypes.LPWSTR), ("pServerName", wintypes.LPWSTR), ("Attributes", wintypes.DWORD)]

    ws = ctypes.WinDLL("winspool.drv")
    flags = 0x2 | 0x4  # local + connections
    needed, returned = wintypes.DWORD(0), wintypes.DWORD(0)
    ws.EnumPrintersW(flags, None, 4, None, 0, ctypes.byref(needed), ctypes.byref(returned))
    if not needed.value:
        return []
    buf = ctypes.create_string_buffer(needed.value)
    if not ws.EnumPrintersW(flags, None, 4, buf, needed, ctypes.byref(needed), ctypes.byref(returned)):
        return []
    arr = ctypes.cast(buf, ctypes.POINTER(PRINTER_INFO_4))
    return [arr[i].pPrinterName for i in range(returned.value)]


def default_windows_printer() -> str:
    if not IS_WIN:
        return ""
    from ctypes import wintypes

    ws = ctypes.WinDLL("winspool.drv")
    size = wintypes.DWORD(0)
    ws.GetDefaultPrinterW(None, ctypes.byref(size))
    if not size.value:
        return ""
    buf = ctypes.create_unicode_buffer(size.value)
    return buf.value if ws.GetDefaultPrinterW(buf, ctypes.byref(size)) else ""


def _windows_raw_print(name: str, data: bytes) -> None:
    from ctypes import wintypes

    class DOC_INFO_1(ctypes.Structure):
        _fields_ = [("pDocName", wintypes.LPWSTR), ("pOutputFile", wintypes.LPWSTR), ("pDatatype", wintypes.LPWSTR)]

    ws = ctypes.WinDLL("winspool.drv", use_last_error=True)
    ws.OpenPrinterW.argtypes = [wintypes.LPWSTR, ctypes.POINTER(wintypes.HANDLE), ctypes.c_void_p]
    ws.StartDocPrinterW.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p]
    ws.StartDocPrinterW.restype = wintypes.DWORD
    ws.WritePrinter.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    for fn in ("StartPagePrinter", "EndPagePrinter", "EndDocPrinter", "ClosePrinter"):
        getattr(ws, fn).argtypes = [wintypes.HANDLE]
    h = wintypes.HANDLE()
    if not ws.OpenPrinterW(name, ctypes.byref(h), None):
        raise PrinterError("printer '%s' not found (error %d)" % (name, ctypes.get_last_error()))
    try:
        doc = DOC_INFO_1("Online Kass receipt", None, "RAW")
        if not ws.StartDocPrinterW(h, 1, ctypes.byref(doc)):
            raise PrinterError("printer '%s' refused the job (error %d)" % (name, ctypes.get_last_error()))
        try:
            ws.StartPagePrinter(h)
            buf = (ctypes.c_char * len(data)).from_buffer_copy(data)
            written = wintypes.DWORD(0)
            ok = ws.WritePrinter(h, buf, len(data), ctypes.byref(written))
            ws.EndPagePrinter(h)
            if not ok or written.value != len(data):
                raise PrinterError("printer '%s': write failed (error %d)" % (name, ctypes.get_last_error()))
        finally:
            ws.EndDocPrinter(h)
    finally:
        ws.ClosePrinter(h)


def send_to_printer(doc: EscPos, pr: dict) -> str:
    """Sends a document; returns where it went. Raises PrinterError."""
    kind = pr.get("type") or "none"
    data = doc.data()
    try:
        if kind == "none":
            return "-"
        if kind == "windows":
            name = pr.get("name") or default_windows_printer()
            if not name:
                raise PrinterError("no Windows printer is selected")
            _windows_raw_print(name, data)
            return name
        if kind == "serial":
            port = pr.get("port")
            if not port:
                raise PrinterError("no COM port is selected for the printer")
            sp = SerialPort(port, int(pr.get("baudrate") or 9600))
            try:
                sp.write(data)
            finally:
                sp.close()
            return port
        if kind == "network":
            host, tcp = pr.get("host"), int(pr.get("tcp_port") or 9100)
            if not host:
                raise PrinterError("no printer IP address")
            with socket.create_connection((host, tcp), timeout=5) as s:
                s.sendall(data)
            return "%s:%d" % (host, tcp)
        if kind == "file":
            target = _path("printed.txt")
            with open(target, "a", encoding="utf-8") as f:
                f.write("\n".join(doc.preview) + "\n" + "=" * doc.width + "\n")
            return target
        raise PrinterError("unknown printer type: %s" % kind)
    except PrinterError:
        raise
    except OSError as e:
        raise PrinterError(str(e))


# ============================================================================ barcodes


def clean_code(raw: str) -> str:
    code = (raw or "").strip().replace("\x00", "")
    if len(code) > 3 and code[0] == "]" and code[1].isalpha() and code[2].isdigit():
        code = code[3:]  # AIM symbology prefix, e.g. ]d2 ]Q3 ]C1 ]E0
    return code.lstrip("\x1d").strip()


def code_variants(code: str):
    """Barcodes to look for and the marking code (GS1 DataMatrix / QR with a GTIN) of a scan."""
    out = [code]
    marking = None
    if len(code) >= 16 and code[:2] == "01" and code[2:16].isdigit():
        gtin = code[2:16]
        out += [gtin, gtin.lstrip("0"), gtin[1:]]
        if len(code) > 16:
            marking = code  # full code with serial number and crypto tail (GS separators kept)
    elif len(code) == 14 and code.isdigit() and code[0] == "0":
        out.append(code[1:])
    elif len(code) == 12 and code.isdigit():
        out.append("0" + code)  # UPC-A -> EAN-13
    uniq = []
    for c in out:
        if c and c not in uniq:
            uniq.append(c)
    return uniq, marking


class Catalog:
    def __init__(self, products=None):
        self.by_code, self.by_id = {}, {}
        self.load(products or [])

    def load(self, products) -> None:
        by_code, by_id = {}, {}
        for p in products:
            by_id[p["id"]] = p
            for b in p.get("barcodes") or []:
                by_code[b] = p
        for p in products:
            if p.get("sku"):
                by_code.setdefault(p["sku"], p)
        self.by_code, self.by_id = by_code, by_id

    def find(self, code: str):
        codes, marking = code_variants(code)
        for c in codes:
            if c in self.by_code:
                return self.by_code[c], marking
        return None, marking


# ============================================================================== API


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message

    @property
    def retryable(self) -> bool:
        return self.status >= 500 or self.status == 429


class NetworkError(Exception):
    pass


class Api:
    def __init__(self, settings: dict, on_status=None):
        self.base = (settings.get("api_url") or "").rstrip("/")
        self.key = settings.get("api_key") or ""
        self.on_status = on_status

    @property
    def configured(self) -> bool:
        return bool(self.base and self.key)

    def call(self, method: str, path: str, body=None, timeout: float = 15):
        if not self.configured:
            raise ApiError(0, "NOT_CONFIGURED", tr("not_configured"))
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(self.base + "/desk" + path, data=data, method=method)
        req.add_header("Authorization", "Bearer " + self.key)
        req.add_header("Accept", "application/json")
        req.add_header("Accept-Language", LANG)
        req.add_header("User-Agent", "OnlineKassDesk/" + VERSION)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                payload = json.loads(r.read().decode("utf-8") or "{}")
            self._status(True)
            return payload.get("data")
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read().decode("utf-8")).get("error") or {}
            except Exception:
                err = {}
            self._status(e.code < 500)
            if e.code in (502, 503, 504):
                raise NetworkError("HTTP %d" % e.code)
            raise ApiError(e.code, err.get("code") or ("HTTP_%d" % e.code), err.get("message") or str(e))
        except (urllib.error.URLError, socket.timeout, ConnectionError, OSError) as e:
            self._status(False)
            raise NetworkError(str(getattr(e, "reason", e)))

    def _status(self, online: bool) -> None:
        if self.on_status:
            self.on_status(online)


class Outbox:
    """Sales made without a connection, kept on disk until the server accepts them."""

    def __init__(self):
        self.lock = threading.Lock()
        self.items = read_json("outbox.json", [])

    def add(self, body: dict) -> None:
        with self.lock:
            self.items.append(body)
            write_json("outbox.json", self.items)

    def count(self) -> int:
        with self.lock:
            return len(self.items)

    def next_number(self) -> str:
        with self.lock:
            c = read_json("counter.json", {"n": 0})
            c["n"] = int(c.get("n", 0)) + 1
            write_json("counter.json", c)
            return "OFF-%05d" % c["n"]

    def flush(self, api: Api) -> int:
        """Sends what it can; returns the number sent. Stops at the first network problem."""
        sent = 0
        while True:
            with self.lock:
                if not self.items:
                    return sent
                body = self.items[0]
            try:
                api.call("POST", "/sales", body)
            except NetworkError:
                return sent
            except ApiError as e:
                if e.retryable:
                    return sent
                log.error("offline sale %s rejected: %s %s", body.get("localNumber"), e.code, e.message)
                failed = read_json("outbox_failed.json", [])
                failed.append({"sale": body, "error": {"code": e.code, "message": e.message}, "at": _now_iso()})
                write_json("outbox_failed.json", failed)
            with self.lock:
                if self.items and self.items[0] is body:
                    self.items.pop(0)
                    write_json("outbox.json", self.items)
            sent += 1


class DeclinedQueue:
    """Receipts the cashier cleared before payment, kept on disk until the server has them (shown in History)."""

    def __init__(self):
        self.lock = threading.Lock()
        self.items = read_json("declined.json", [])

    def add(self, event: dict) -> None:
        with self.lock:
            self.items.append(event)
            self.items = self.items[-500:]
            write_json("declined.json", self.items)

    def count(self) -> int:
        with self.lock:
            return len(self.items)

    def flush(self, api: Api) -> int:
        sent = 0
        while True:
            with self.lock:
                if not self.items:
                    return sent
                ev = self.items[0]
            try:
                api.call("POST", "/declined", ev)
            except NetworkError:
                return sent
            except ApiError as e:
                if e.retryable:
                    return sent
                log.error("declined receipt not accepted: %s %s", e.code, e.message)
            with self.lock:
                if self.items and self.items[0] is ev:
                    self.items.pop(0)
                    write_json("declined.json", self.items)
            sent += 1


def _now_iso() -> str:
    n = datetime.now(timezone.utc)
    return n.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (n.microsecond // 1000)


def local_time(iso: str, fmt: str = "%H:%M") -> str:
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone().strftime(fmt)
    except (ValueError, AttributeError):
        return ""


# ========================================================================== scanner


class ScannerReader(threading.Thread):
    """Reads codes from the COM port of the scanner and hands them to the window."""

    def __init__(self, on_code, on_state, get_settings):
        super().__init__(daemon=True)
        self.on_code, self.on_state, self.get_settings = on_code, on_state, get_settings
        self.stop_event = threading.Event()
        self.restart_event = threading.Event()

    def restart(self):
        self.restart_event.set()

    def stop(self):
        self.stop_event.set()

    def _candidates(self, s):
        port = (s.get("scanner") or {}).get("port") or "auto"
        if port != "auto":
            return [port]
        busy = (s.get("printer") or {}).get("port") if (s.get("printer") or {}).get("type") == "serial" else None
        ports = [p for p in list_com_ports() if p[0] != busy]
        ports.sort(key=lambda p: 0 if any(w in p[1].upper() for w in ("USB", "SCAN", "CDC", "VCP", "ACM")) else 1)
        return [p[0] for p in ports]

    def run(self):
        while not self.stop_event.is_set():
            self.restart_event.clear()
            s = self.get_settings()
            sc = s.get("scanner") or {}
            if (sc.get("port") or "auto") == "none":
                self.on_state("keyboard", "")
                self.restart_event.wait()
                continue
            ser, last_err = None, ""
            for port in self._candidates(s):
                try:
                    ser = SerialPort(port, int(sc.get("baudrate") or 9600), timeout=0.1)
                    break
                except OSError as e:
                    last_err = "%s: %s" % (port, e)
            if ser is None:
                self.on_state("error" if last_err else "searching", last_err)
                self.restart_event.wait(3)
                continue
            log.info("scanner connected on %s", ser.port)
            self.on_state("connected", ser.port)
            try:
                self._read_loop(ser)
            except OSError as e:
                log.warning("scanner on %s lost: %s", ser.port, e)
                self.on_state("error", "%s: %s" % (ser.port, e))
                self.restart_event.wait(2)
            finally:
                ser.close()

    def _read_loop(self, ser: SerialPort):
        buf = b""
        last = time.time()
        while not self.stop_event.is_set() and not self.restart_event.is_set():
            chunk = ser.read(512)
            now = time.time()
            if chunk:
                buf += chunk
                last = now
            while True:
                cut = [i for i in (buf.find(b"\r"), buf.find(b"\n")) if i >= 0]
                if not cut:
                    break
                i = min(cut)
                self._emit(buf[:i])
                buf = buf[i + 1:]
            if buf and now - last > 0.15:  # scanners without a line ending
                self._emit(buf)
                buf = b""

    def _emit(self, raw: bytes):
        if not raw.strip():
            return
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = raw.decode("latin-1")
        code = clean_code(text)
        if code:
            self.on_code(code)


# ============================================================================== window

C = {
    "bg": "#eef3f2", "surface": "#ffffff", "surface2": "#f4f8f7", "border": "#d3dfdd", "fg": "#0d1e24", "muted": "#5d7177",
    "primary": "#0b7280", "primary_hover": "#095f6b", "primary_soft": "#d6eced", "deep": "#074250", "deep_text": "#b6dde0",
    "accent": "#e29826", "accent_hover": "#cc8517", "danger": "#be2634", "success": "#187d4e", "warn": "#a85c06", "disabled": "#c4d0ce",
}
UI_FONT = "Segoe UI" if IS_WIN else "Helvetica"
F = {
    "base": (UI_FONT, 10), "small": (UI_FONT, 9), "small_b": (UI_FONT, 9, "bold"), "row": (UI_FONT, 11), "entry": (UI_FONT, 16),
    "title": (UI_FONT, 15, "bold"), "btn": (UI_FONT, 10, "bold"), "btn_lg": (UI_FONT, 15, "bold"), "total": (UI_FONT, 34, "bold"),
    "total_cur": (UI_FONT, 14), "label": (UI_FONT, 10), "big": (UI_FONT, 13, "bold"),
}
BUTTONS = {
    "primary": (C["primary"], "#ffffff", C["primary_hover"]),
    "accent": (C["accent"], "#241600", C["accent_hover"]),
    "secondary": (C["surface"], C["fg"], C["surface2"]),
    "ghost": (C["surface2"], C["fg"], C["border"]),
    "danger": (C["danger"], "#ffffff", "#a11f2c"),
}


def make_button(parent, text, command, kind="secondary", size="md"):
    bg, fg, hover = BUTTONS[kind]
    font = F["btn_lg"] if size == "lg" else F["btn"] if size == "md" else F["small_b"]
    b = tk.Button(
        parent, text=text, command=command, bg=bg, fg=fg, activebackground=hover, activeforeground=fg,
        disabledforeground="#8a9a97", relief="flat", bd=0, font=font, cursor="hand2",
        padx=16 if size != "sm" else 10, pady=14 if size == "lg" else 7 if size == "md" else 4,
        highlightthickness=1 if kind in ("secondary", "ghost") else 0, highlightbackground=C["border"],
    )
    b._colors = (bg, hover)  # type: ignore[attr-defined]
    b.bind("<Enter>", lambda e: b.configure(bg=hover) if str(b["state"]) != "disabled" else None)
    b.bind("<Leave>", lambda e: b.configure(bg=bg) if str(b["state"]) != "disabled" else None)
    return b


def set_enabled(b, on: bool):
    bg, _ = b._colors
    b.configure(state="normal" if on else "disabled", bg=bg if on else C["disabled"], cursor="hand2" if on else "arrow")


def beep(ok=False):
    if IS_WIN:
        try:
            import winsound

            winsound.MessageBeep(winsound.MB_OK if ok else winsound.MB_ICONHAND)
        except Exception:
            pass


class Modal(tk.Toplevel):
    """Small dialog centred on the main window; Enter confirms, Esc closes."""

    def __init__(self, app, title):
        super().__init__(app.root)
        self.app = app
        self.title(title)
        self.configure(bg=C["surface"], padx=24, pady=20)
        self.resizable(False, False)
        self.transient(app.root)
        self.bind("<Escape>", lambda e: self.close())
        self.protocol("WM_DELETE_WINDOW", self.close)

    def show(self, focus=None):
        self.update_idletasks()
        r = self.app.root
        x = r.winfo_rootx() + (r.winfo_width() - self.winfo_reqwidth()) // 2
        y = r.winfo_rooty() + (r.winfo_height() - self.winfo_reqheight()) // 3
        self.geometry("+%d+%d" % (max(0, x), max(0, y)))
        try:
            self.wait_visibility()
            self.grab_set()
        except tk.TclError:
            pass
        (focus or self).focus_set()

    def close(self):
        try:
            self.grab_release()
        except tk.TclError:
            pass
        self.destroy()
        self.app.focus_scan()

    def heading(self, text, sub=None):
        tk.Label(self, text=text, bg=C["surface"], fg=C["fg"], font=F["title"], anchor="w").pack(fill="x")
        if sub:
            tk.Label(self, text=sub, bg=C["surface"], fg=C["muted"], font=F["label"], anchor="w", justify="left", wraplength=420).pack(fill="x", pady=(2, 0))

    def amount_entry(self, initial=""):
        e = tk.Entry(self, font=F["entry"], relief="flat", bg=C["surface2"], fg=C["fg"], highlightthickness=2, highlightbackground=C["border"], highlightcolor=C["primary"], justify="right", width=16)
        e.insert(0, initial)
        e.select_range(0, "end")
        return e

    def footer(self, ok_text, on_ok, kind="primary"):
        row = tk.Frame(self, bg=C["surface"])
        row.pack(fill="x", pady=(18, 0))
        ok = make_button(row, ok_text, on_ok, kind)
        ok.pack(side="right")
        make_button(row, tr("cancel"), self.close, "secondary").pack(side="right", padx=(0, 8))
        self.bind("<Return>", lambda e: on_ok())
        return ok


def _period_range(key: str):
    """(from, to) as UTC ISO strings for a period key, in this computer's local time."""
    now = datetime.now().astimezone()
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    day = 86400
    if key == "today":
        a, b = start, None
    elif key == "yesterday":
        a, b = datetime.fromtimestamp(start.timestamp() - day).astimezone(), start
    elif key == "7d":
        a, b = datetime.fromtimestamp(start.timestamp() - 6 * day).astimezone(), None
    elif key == "30d":
        a, b = datetime.fromtimestamp(start.timestamp() - 29 * day).astimezone(), None
    else:
        return None, None

    def iso(d):
        return d.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z") if d else None

    return iso(a), iso(b)


class HistoryWindow(tk.Toplevel):
    """Sales, declined receipts, refunds, goods received and shifts of this cash desk, with filters."""

    TYPES = ("all", "sale", "declined", "refund", "arrival", "shift")
    PERIODS = ("today", "yesterday", "7d", "30d", "all")
    PAGE = 50

    def __init__(self, app):
        super().__init__(app.root)
        self.app = app
        self.title("Online Kass - " + tr("history_title"))
        self.configure(bg=C["bg"], padx=16, pady=14)
        self.geometry("1100x640")
        self.minsize(820, 460)
        self.protocol("WM_DELETE_WINDOW", self.close)
        self.bind("<Escape>", lambda e: self.close())
        self.rows = {}
        self.page = 1
        self.total = 0
        self.loading = False

        top = tk.Frame(self, bg=C["bg"])
        top.pack(fill="x")
        tk.Label(top, text=tr("history_title"), bg=C["bg"], fg=C["fg"], font=F["title"]).pack(side="left")
        make_button(top, tr("refresh"), self.reload, "ghost", "sm").pack(side="right")

        bar = tk.Frame(self, bg=C["surface"], highlightthickness=1, highlightbackground=C["border"], padx=12, pady=10)
        bar.pack(fill="x", pady=(10, 0))
        self._type_labels = {tr("h_" + t): t for t in self.TYPES}
        self._period_labels = {tr("p_" + p): p for p in self.PERIODS}
        self.type_var = tk.StringVar(value=tr("h_all"))
        self.period_var = tk.StringVar(value=tr("p_today"))
        self.q_var = tk.StringVar()
        tk.Label(bar, text=tr("col_type"), bg=C["surface"], fg=C["muted"], font=F["small"]).pack(side="left")
        tc = ttk.Combobox(bar, textvariable=self.type_var, values=list(self._type_labels), state="readonly", width=20)
        tc.pack(side="left", padx=(6, 14))
        tc.bind("<<ComboboxSelected>>", lambda e: self.reload())
        tk.Label(bar, text=tr("period"), bg=C["surface"], fg=C["muted"], font=F["small"]).pack(side="left")
        pc = ttk.Combobox(bar, textvariable=self.period_var, values=list(self._period_labels), state="readonly", width=18)
        pc.pack(side="left", padx=(6, 14))
        pc.bind("<<ComboboxSelected>>", lambda e: self.reload())
        tk.Label(bar, text=tr("search_hint"), bg=C["surface"], fg=C["muted"], font=F["small"]).pack(side="left")
        e = tk.Entry(bar, textvariable=self.q_var, font=F["base"], relief="flat", bg=C["surface2"], fg=C["fg"], highlightthickness=1, highlightbackground=C["border"], width=24)
        e.pack(side="left", ipady=4, padx=(6, 0))
        e.bind("<Return>", lambda ev: self.reload())
        make_button(bar, tr("find"), self.reload, "primary", "sm").pack(side="left", padx=(8, 0))

        self.summary_lbl = tk.Label(self, bg=C["bg"], fg=C["fg"], font=F["small_b"], anchor="w", justify="left")
        self.summary_lbl.pack(fill="x", pady=(10, 4))

        card = tk.Frame(self, bg=C["surface"], highlightthickness=1, highlightbackground=C["border"])
        card.pack(fill="both", expand=True)
        cols = ("time", "type", "number", "details", "amount", "status")
        self.tree = ttk.Treeview(card, columns=cols, show="headings", style="Cart.Treeview", selectmode="browse")
        for col, w, anchor, stretch in (("time", 120, "w", False), ("type", 150, "w", False), ("number", 110, "w", False), ("details", 360, "w", True), ("amount", 130, "e", False), ("status", 190, "w", False)):
            self.tree.heading(col, text=tr("col_" + col), anchor=anchor)
            self.tree.column(col, width=w, anchor=anchor, stretch=stretch, minwidth=60)
        self.tree.tag_configure("declined", foreground=C["danger"])
        self.tree.tag_configure("refund", foreground=C["warn"])
        self.tree.tag_configure("arrival", foreground=C["primary"])
        self.tree.tag_configure("shift", foreground=C["muted"])
        self.tree.tag_configure("cash", foreground=C["muted"])
        self.tree.tag_configure("pending", foreground=C["warn"])
        sb = ttk.Scrollbar(card, orient="vertical", command=self.tree.yview, style="Desk.Vertical.TScrollbar")
        self.tree.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        self.tree.pack(side="left", fill="both", expand=True)
        self.tree.bind("<Double-1>", lambda ev: self.show_details())
        self.tree.bind("<Return>", lambda ev: self.show_details())

        bottom = tk.Frame(self, bg=C["bg"])
        bottom.pack(fill="x", pady=(8, 0))
        self.status_lbl = tk.Label(bottom, bg=C["bg"], fg=C["muted"], font=F["small"], anchor="w")
        self.status_lbl.pack(side="left")
        make_button(bottom, tr("details"), self.show_details, "ghost", "sm").pack(side="right")
        self.more_btn = make_button(bottom, tr("load_more"), self.load_more, "secondary", "sm")
        self.more_btn.pack(side="right", padx=(0, 6))
        self.reload()

    def close(self):
        self.app.history_win = None
        self.destroy()
        self.app.focus_scan()

    # ------------------------------------------------------------------ data

    def _params(self, page):
        t = self._type_labels.get(self.type_var.get(), "all")
        a, b = _period_range(self._period_labels.get(self.period_var.get(), "today"))
        p = {"page": page, "limit": self.PAGE}
        if t != "all":
            p["type"] = t
        if a:
            p["from"] = a
        if b:
            p["to"] = b
        q = self.q_var.get().strip()
        if q:
            p["q"] = q
        return p

    def reload(self):
        self.page = 1
        self.total = 0
        self.tree.delete(*self.tree.get_children())
        self.rows = {}
        self._fetch(1)

    def load_more(self):
        if not self.loading and self._shown() < self.total:
            self._fetch(self.page + 1)

    def _shown(self):
        return sum(1 for k in self.rows if not k.startswith("pending:"))

    def _fetch(self, page):
        self.loading = True
        self.status_lbl.configure(text=tr("h_loading"))
        path = "/history?" + urllib.parse.urlencode(self._params(page))
        # Api.call() returns only "data"; the history also needs "meta" (total, summary)
        self.app.bg(lambda: self._call_full(path), lambda r: self._loaded(page, r), self._failed)

    def _call_full(self, path):
        api = self.app.api
        if not api.configured:
            raise ApiError(0, "NOT_CONFIGURED", tr("not_configured"))
        req = urllib.request.Request(api.base + "/desk" + path, method="GET")
        req.add_header("Authorization", "Bearer " + api.key)
        req.add_header("Accept", "application/json")
        req.add_header("Accept-Language", LANG)
        req.add_header("User-Agent", "OnlineKassDesk/" + VERSION)
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                payload = json.loads(r.read().decode("utf-8") or "{}")
            api._status(True)
            return payload
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read().decode("utf-8")).get("error") or {}
            except Exception:
                err = {}
            api._status(e.code < 500)
            if e.code in (502, 503, 504):
                raise NetworkError("HTTP %d" % e.code)
            raise ApiError(e.code, err.get("code") or ("HTTP_%d" % e.code), err.get("message") or str(e))
        except (urllib.error.URLError, socket.timeout, ConnectionError, OSError) as e:
            api._status(False)
            raise NetworkError(str(getattr(e, "reason", e)))

    def _alive(self):
        try:
            return bool(self.winfo_exists())
        except tk.TclError:
            return False

    def _loaded(self, page, payload):
        if not self._alive():
            return
        self.loading = False
        self.page = page
        meta = payload.get("meta") or {}
        self.total = int(meta.get("total") or 0)
        if page == 1:
            self._insert_pending()
        for it in payload.get("data") or []:
            self._insert(it)
        sm = meta.get("summary") or {}
        cur = self.app.currency

        def g(k):
            return sm.get(k) or {}

        self.summary_lbl.configure(text=tr("h_summary", s=g("sale").get("count", 0), sa=fmt_money(g("sale").get("amount", 0), cur), d=g("declined").get("count", 0), r=g("refund").get("count", 0), a=g("arrival").get("count", 0)))
        self.status_lbl.configure(text=tr("h_empty") if not self.rows else tr("h_shown", n=self._shown(), total=self.total))
        set_enabled(self.more_btn, self._shown() < self.total)

    def _failed(self, e):
        if not self._alive():
            return
        self.loading = False
        if isinstance(e, NetworkError):
            if not self.rows:
                self._insert_pending()
            self.status_lbl.configure(text=tr("h_offline"))
            self.summary_lbl.configure(text="")
        else:
            self.status_lbl.configure(text=str(getattr(e, "message", e)))
        set_enabled(self.more_btn, False)

    def _insert_pending(self):
        """Sales made offline and not yet on the server: shown on top, only in this window."""
        if self._type_labels.get(self.type_var.get(), "all") not in ("all", "sale"):
            return
        with self.app.outbox.lock:
            pending = list(self.app.outbox.items)
        for i, body in enumerate(reversed(pending)):
            lines = body.get("lines") or []
            amount = sum(line_gross(l.get("qty") or 0, l.get("price") or 0) for l in lines)
            self._insert({
                "id": "pending:%d" % i, "type": "sale", "kind": "pending", "at": body.get("createdAt"), "number": body.get("localNumber"), "amount": amount,
                "items": [{"name": self._product_name(l.get("productId")), "qty": l.get("qty")} for l in lines],
            })

    def _product_name(self, pid):
        return (self.app.catalog.by_id.get(pid) or {}).get("name") or "?"

    def _status_text(self, it):
        k = it.get("kind") or it.get("status") or ""
        if it["type"] == "declined":
            return tr("st_rejected", code=it.get("note") or "") if k == "rejected" else tr("st_cleared")
        if it["type"] == "refund":
            return it.get("note") or ""
        if k == "pending":
            return tr("st_pending")
        key = "st_" + k
        txt = tr(key)
        return txt if txt != key else k

    def _details_text(self, it):
        parts = ["%s x%s" % (x.get("name") or "?", fmt_qty(x.get("qty") or 0)) for x in (it.get("items") or [])]
        txt = ", ".join(parts[:4]) + (" ..." if len(parts) > 4 else "")
        if it["type"] == "arrival":
            sup = it.get("supplierName")
            txt = (tr("from_supplier", name=sup) if sup else tr("no_supplier")) + (": " + txt if txt else "")
        elif it["type"] in ("shift", "cash"):
            txt = " ".join(x for x in (it.get("cashierName"), it.get("note") if it.get("note") != "auto" else "") if x)
        return txt

    def _insert(self, it):
        if it["id"] in self.rows:
            return
        self.rows[it["id"]] = it
        when = local_time(it.get("at") or "", "%d.%m %H:%M")
        amount = it.get("amount") or 0
        sign = "-" if it["type"] == "refund" or (it["type"] == "cash" and it.get("kind") == "out") else ""
        amt = "" if it["type"] == "shift" and not amount else sign + fmt_money(amount, self.app.currency)
        tag = "pending" if it.get("kind") == "pending" else it["type"]
        self.tree.insert("", "end", iid=it["id"], values=(when, tr("r_" + it["type"]), it.get("number") or "", self._details_text(it), amt, self._status_text(it)), tags=(tag,))

    # ------------------------------------------------------------------ details

    def show_details(self):
        sel = self.tree.selection()
        it = self.rows.get(sel[0]) if sel else None
        if not it:
            return
        d = tk.Toplevel(self)
        d.title(tr("details"))
        d.configure(bg=C["surface"], padx=22, pady=18)
        d.transient(self)
        d.bind("<Escape>", lambda e: d.destroy())
        tk.Label(d, text="%s %s" % (tr("r_" + it["type"]), it.get("number") or ""), bg=C["surface"], fg=C["fg"], font=F["title"], anchor="w").pack(fill="x")
        sub = "  |  ".join(x for x in (local_time(it.get("at") or "", "%d.%m.%Y %H:%M"), self._status_text(it), it.get("cashierName") or "", it.get("terminalName") or "") if x)
        tk.Label(d, text=sub, bg=C["surface"], fg=C["muted"], font=F["label"], anchor="w", justify="left", wraplength=520).pack(fill="x", pady=(2, 10))
        for x in it.get("items") or []:
            row = tk.Frame(d, bg=C["surface"])
            row.pack(fill="x")
            tk.Label(row, text=x.get("name") or "?", bg=C["surface"], fg=C["fg"], font=F["row"], anchor="w").pack(side="left")
            tk.Label(row, text="x " + fmt_qty(x.get("qty") or 0), bg=C["surface"], fg=C["muted"], font=F["row"]).pack(side="right", padx=(24, 0))
        if it["type"] == "arrival":
            tk.Label(d, text=tr("from_supplier", name=it["supplierName"]) if it.get("supplierName") else tr("no_supplier"), bg=C["surface"], fg=C["muted"], font=F["label"], anchor="w").pack(fill="x", pady=(8, 0))
        if it.get("note") and it["type"] in ("refund", "cash", "arrival"):
            tk.Label(d, text=it["note"], bg=C["surface"], fg=C["muted"], font=F["label"], anchor="w", wraplength=520, justify="left").pack(fill="x", pady=(6, 0))
        tk.Label(d, text=fmt_money(it.get("amount") or 0, self.app.currency), bg=C["surface"], fg=C["fg"], font=F["big"], anchor="e").pack(fill="x", pady=(12, 0))
        row = tk.Frame(d, bg=C["surface"])
        row.pack(fill="x", pady=(14, 0))
        make_button(row, tr("cancel"), d.destroy, "secondary").pack(side="right")
        if it["type"] == "sale" and it.get("kind") != "pending":
            make_button(row, tr("print_again"), lambda: (self._reprint(it["id"]), d.destroy()), "primary").pack(side="right", padx=(0, 8))
        d.update_idletasks()
        d.geometry("+%d+%d" % (self.winfo_rootx() + 120, self.winfo_rooty() + 80))
        d.focus_set()

    def _reprint(self, sale_id):
        pr = dict(self.app.settings.get("printer") or {})

        def work():
            receipt = self.app.api.call("GET", "/sales/%s/receipt" % sale_id)
            return send_to_printer(render_receipt(receipt, pr), pr)

        self.app.bg(work, self.app._printed, self.app._print_failed)


class DeskApp:
    def __init__(self, root):
        self.root = root
        self.settings = load_settings()
        set_language(self.settings.get("language"))
        self.ui_queue = queue.Queue()
        self.tasks = queue.Queue()
        self.api = Api(self.settings, self._on_online)
        self.catalog = Catalog(read_json("catalog.json", []))
        self.session = read_json("session.json", None)
        self.outbox = Outbox()
        self.declined = DeclinedQueue()
        self.history_win = None
        self.cart = []
        self.version = 0
        self.quote = None
        self.pending_marked = None
        self.busy = False
        self.online = None
        self.last_doc = None
        self.last_number = ""
        self.scanner_state = ("searching", "")
        self.printer_note = ""
        self._quote_job = None

        root.title("Online Kass")
        root.geometry("1220x760")
        root.minsize(980, 620)
        root.configure(bg=C["bg"])
        root.protocol("WM_DELETE_WINDOW", self.quit)
        self.build_ui()
        root.after(40, self._pump)
        threading.Thread(target=self._worker, daemon=True).start()
        self.scanner = ScannerReader(lambda c: self.post(self.on_code, c), lambda st, info: self.post(self._scanner_state, st, info), lambda: self.settings)
        self.scanner.start()
        threading.Thread(target=self._sync_loop, daemon=True).start()
        if not self.api.configured:
            root.after(400, self._ask_config)
        else:
            self.refresh_session()
            self.refresh_catalog()

    # ------------------------------------------------------------------ threads

    def post(self, fn, *args):
        self.ui_queue.put((fn, args))

    def _pump(self):
        try:
            while True:
                fn, args = self.ui_queue.get_nowait()
                try:
                    fn(*args)
                except Exception:
                    log.exception("ui callback failed")
        except queue.Empty:
            pass
        self.root.after(40, self._pump)

    def bg(self, fn, ok=None, err=None):
        self.tasks.put((fn, ok, err))

    def _worker(self):
        while True:
            fn, ok, err = self.tasks.get()
            try:
                res = fn()
                if ok:
                    self.post(ok, res)
            except Exception as e:  # noqa: BLE001 - reported to the window
                if not isinstance(e, (ApiError, NetworkError, PrinterError)):
                    log.exception("background task failed")
                self.post(err or self._show_error, e)

    def _sync_loop(self):
        last_session = time.time()
        last_catalog = time.time()
        while True:
            time.sleep(4)
            if not self.api.configured:
                continue
            try:
                if self.outbox.count():
                    if self.outbox.flush(self.api):
                        self.post(self._update_footer)
                        last_session = 0
                if self.declined.count():
                    self.declined.flush(self.api)
                now = time.time()
                if now - last_session > 30:
                    last_session = now
                    self.post(self.apply_session, self.api.call("GET", "/session"))
                if now - last_catalog > 600:
                    last_catalog = now
                    self.post(self._apply_catalog, self.api.call("GET", "/catalog"))
            except (NetworkError, ApiError):
                pass
            except Exception:
                log.exception("sync failed")

    def _on_online(self, online: bool):
        if online != self.online:
            self.post(self._set_online, online)

    # ------------------------------------------------------------------ layout

    def build_ui(self):
        for w in self.root.winfo_children():
            w.destroy()
        style = ttk.Style(self.root)
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure("Cart.Treeview", background=C["surface"], fieldbackground=C["surface"], foreground=C["fg"], rowheight=38, font=F["row"], borderwidth=0, relief="flat")
        style.configure("Cart.Treeview.Heading", background=C["surface2"], foreground=C["muted"], font=F["small_b"], relief="flat", borderwidth=0, padding=(10, 8))
        style.map("Cart.Treeview", background=[("selected", C["primary_soft"])], foreground=[("selected", C["fg"])])
        style.map("Cart.Treeview.Heading", background=[("active", C["surface2"])])
        style.layout("Cart.Treeview", [("Treeview.treearea", {"sticky": "nswe"})])
        style.configure("Desk.Vertical.TScrollbar", background=C["surface2"], troughcolor=C["surface"], bordercolor=C["surface"], arrowcolor=C["muted"])

        # header -------------------------------------------------------------
        head = tk.Frame(self.root, bg=C["deep"], padx=18, pady=10)
        head.pack(fill="x")
        mark = tk.Canvas(head, width=42, height=42, bg=C["deep"], highlightthickness=0)
        mark.create_polygon(10, 10, 32, 10, 32, 32, 10, 32, outline=C["accent"], fill="", width=2)
        mark.create_polygon(21, 5.5, 36.5, 21, 21, 36.5, 5.5, 21, outline=C["accent"], fill="", width=2)
        mark.pack(side="left", padx=(0, 12))
        titles = tk.Frame(head, bg=C["deep"])
        titles.pack(side="left")
        self.shop_lbl = tk.Label(titles, bg=C["deep"], fg="#ffffff", font=F["title"], anchor="w")
        self.shop_lbl.pack(anchor="w")
        self.place_lbl = tk.Label(titles, bg=C["deep"], fg=C["deep_text"], font=F["label"], anchor="w")
        self.place_lbl.pack(anchor="w")
        self.online_lbl = tk.Label(head, bg=C["deep"], font=F["btn"], padx=10, pady=4)
        self.online_lbl.pack(side="right")
        info = tk.Frame(head, bg=C["deep"])
        info.pack(side="right", padx=18)
        self.cashier_lbl = tk.Label(info, bg=C["deep"], fg="#ffffff", font=F["btn"], anchor="e")
        self.cashier_lbl.pack(anchor="e")
        self.shift_lbl = tk.Label(info, bg=C["deep"], fg=C["deep_text"], font=F["label"], anchor="e")
        self.shift_lbl.pack(anchor="e")

        # footer -------------------------------------------------------------
        foot = tk.Frame(self.root, bg=C["surface"], padx=16, pady=8, highlightthickness=1, highlightbackground=C["border"])
        foot.pack(side="bottom", fill="x")
        self.scanner_lbl = tk.Label(foot, bg=C["surface"], fg=C["muted"], font=F["small"])
        self.scanner_lbl.pack(side="left")
        self.printer_lbl = tk.Label(foot, bg=C["surface"], fg=C["muted"], font=F["small"])
        self.printer_lbl.pack(side="left", padx=(18, 0))
        self.queue_lbl = tk.Label(foot, bg=C["surface"], fg=C["warn"], font=F["small_b"])
        self.queue_lbl.pack(side="left", padx=(18, 0))
        self.receipt_lbl = tk.Label(foot, bg=C["surface"], fg=C["muted"], font=F["small"])
        self.receipt_lbl.pack(side="left", padx=(18, 0))
        make_button(foot, tr("settings"), self.open_settings, "ghost", "sm").pack(side="right")
        make_button(foot, tr("history") + "  F5", self.open_history, "ghost", "sm").pack(side="right", padx=(0, 6))
        self.reprint_btn = make_button(foot, tr("reprint"), self.reprint, "ghost", "sm")
        self.reprint_btn.pack(side="right", padx=(0, 6))

        # body ---------------------------------------------------------------
        body = tk.Frame(self.root, bg=C["bg"], padx=18, pady=16)
        body.pack(fill="both", expand=True)
        right = tk.Frame(body, bg=C["bg"], width=360)
        right.pack(side="right", fill="y", padx=(16, 0))
        right.pack_propagate(False)
        left = tk.Frame(body, bg=C["bg"])
        left.pack(side="left", fill="both", expand=True)

        scan = tk.Frame(left, bg=C["surface"], highlightthickness=1, highlightbackground=C["border"], padx=12, pady=8)
        scan.pack(fill="x")
        glass = tk.Canvas(scan, width=26, height=26, bg=C["surface"], highlightthickness=0)
        for x in (4, 7, 9, 13, 15, 19, 22):  # a small barcode glyph
            glass.create_line(x, 5, x, 21, fill=C["primary"], width=2 if x in (4, 13, 22) else 1)
        glass.pack(side="left", padx=(0, 10))
        self.entry = tk.Entry(scan, font=F["entry"], relief="flat", bg=C["surface"], fg=C["fg"], insertbackground=C["primary"], highlightthickness=0)
        self.entry.pack(side="left", fill="x", expand=True, ipady=4)
        self.entry.bind("<Return>", self._entry_enter)
        self.entry.bind("<Up>", lambda e: self._move_sel(-1))
        self.entry.bind("<Down>", lambda e: self._move_sel(1))
        self.entry.bind("<KP_Add>", lambda e: (self.change_qty(1), "break")[1])
        self.entry.bind("<KP_Subtract>", lambda e: (self.change_qty(-1), "break")[1])
        self.hint_lbl = tk.Label(scan, text=tr("scan_hint"), bg=C["surface"], fg=C["muted"], font=F["small"])
        self.hint_lbl.place(in_=self.entry, relx=0, rely=0.5, anchor="w")
        self.hint_lbl.bind("<Button-1>", lambda e: self.entry.focus_set())
        self.entry.bind("<KeyRelease>", lambda e: self._toggle_hint())
        make_button(scan, tr("add"), self._entry_enter, "primary").pack(side="right", padx=(10, 0))

        card = tk.Frame(left, bg=C["surface"], highlightthickness=1, highlightbackground=C["border"])
        card.pack(fill="both", expand=True, pady=(12, 0))
        cols = ("no", "name", "qty", "price", "sum")
        self.tree = ttk.Treeview(card, columns=cols, show="headings", style="Cart.Treeview", selectmode="browse")
        for col, text, w, anchor, stretch in (
            ("no", "#", 48, "center", False), ("name", tr("col_name"), 360, "w", True), ("qty", tr("col_qty"), 90, "center", False),
            ("price", tr("col_price"), 120, "e", False), ("sum", tr("col_sum"), 140, "e", False),
        ):
            self.tree.heading(col, text=text, anchor=anchor)
            self.tree.column(col, width=w, anchor=anchor, stretch=stretch, minwidth=40)
        self.tree.tag_configure("odd", background=C["surface2"])
        self.tree.tag_configure("promo", foreground=C["success"])
        sb = ttk.Scrollbar(card, orient="vertical", command=self.tree.yview, style="Desk.Vertical.TScrollbar")
        self.tree.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        self.tree.pack(side="left", fill="both", expand=True)
        self.tree.bind("<Double-1>", lambda e: self.ask_qty())
        self.empty_lbl = tk.Label(card, text=tr("empty_cart"), bg=C["surface"], fg=C["muted"], font=F["big"])

        self.msg_lbl = tk.Label(left, bg=C["bg"], fg=C["muted"], font=F["label"], anchor="w", justify="left")
        self.msg_lbl.pack(fill="x", pady=(10, 0))

        # right panel ------------------------------------------------------
        total = tk.Frame(right, bg=C["deep"], padx=22, pady=18)
        total.pack(fill="x")
        tk.Label(total, text=tr("to_pay"), bg=C["deep"], fg=C["deep_text"], font=F["label"]).pack(anchor="w")
        amt = tk.Frame(total, bg=C["deep"])
        amt.pack(anchor="w", fill="x")
        self.total_lbl = tk.Label(amt, text="0", bg=C["deep"], fg="#ffffff", font=F["total"])
        self.total_lbl.pack(side="left")
        self.cur_lbl = tk.Label(amt, bg=C["deep"], fg=C["deep_text"], font=F["total_cur"])
        self.cur_lbl.pack(side="left", padx=(8, 0), pady=(14, 0))
        self.sub_lbl = tk.Label(total, bg=C["deep"], fg=C["deep_text"], font=F["label"], anchor="w", justify="left")
        self.sub_lbl.pack(anchor="w", fill="x", pady=(6, 0))
        self.change_lbl = tk.Label(total, bg=C["deep"], fg=C["accent"], font=F["big"], anchor="w", justify="left")
        self.change_lbl.pack(anchor="w", fill="x")

        qty_row = tk.Frame(right, bg=C["bg"])
        qty_row.pack(fill="x", pady=(14, 0))
        self.minus_btn = make_button(qty_row, "− 1", lambda: self.change_qty(-1))
        self.minus_btn.pack(side="left", fill="x", expand=True)
        self.plus_btn = make_button(qty_row, "+ 1", lambda: self.change_qty(1))
        self.plus_btn.pack(side="left", fill="x", expand=True, padx=6)
        self.qty_btn = make_button(qty_row, tr("qty") + "  F2", self.ask_qty)
        self.qty_btn.pack(side="left", fill="x", expand=True)
        self.remove_btn = make_button(right, tr("remove") + "  Del", self.remove_line)
        self.remove_btn.pack(fill="x", pady=(6, 0))

        self.cash_btn = make_button(right, tr("cash") + "   F9", lambda: self.pay("cash"), "accent", "lg")
        self.cash_btn.pack(fill="x", pady=(18, 0))
        self.card_btn = make_button(right, tr("card") + "   F12", lambda: self.pay("card"), "primary", "lg")
        self.card_btn.pack(fill="x", pady=(8, 0))
        self.clear_btn = make_button(right, tr("clear") + "   Esc", self.clear_cart)
        self.clear_btn.pack(fill="x", pady=(8, 0))

        r = self.root
        for seq in ("<F9>", "<F12>", "<F2>", "<Delete>", "<Escape>", "<F5>"):
            r.unbind_all(seq)
        r.bind_all("<F5>", lambda e: self.open_history())
        r.bind_all("<F9>", lambda e: self.pay("cash"))
        r.bind_all("<F12>", lambda e: self.pay("card"))
        r.bind_all("<F2>", lambda e: self.ask_qty())
        r.bind("<Delete>", lambda e: self.remove_line())
        r.bind("<Escape>", lambda e: self.clear_cart())
        self.entry.bind("<Delete>", lambda e: None if self.entry.get() else (self.remove_line(), "break")[1])
        self.entry.bind("<Escape>", lambda e: (self.entry.delete(0, "end"), self._toggle_hint(), "break")[2] if self.entry.get() else (self.clear_cart(), "break")[1])
        self.entry.bind("<plus>", lambda e: (self.change_qty(1), "break")[1] if not self.entry.get() else None)
        self.entry.bind("<minus>", lambda e: (self.change_qty(-1), "break")[1] if not self.entry.get() else None)

        self._apply_header()
        self._set_online(self.online)
        self._scanner_state(*self.scanner_state)
        self.render()
        self.focus_scan()

    def focus_scan(self):
        try:
            if self.root.grab_current() is None:
                self.entry.focus_set()
        except tk.TclError:
            pass

    def _toggle_hint(self):
        if self.entry.get():
            self.hint_lbl.place_forget()
        else:
            self.hint_lbl.place(in_=self.entry, relx=0, rely=0.5, anchor="w")

    # ------------------------------------------------------------------ state shown

    @property
    def currency(self) -> str:
        return ((self.session or {}).get("shop") or {}).get("currency") or self.settings.get("currency") or "UZS"

    @property
    def shift(self):
        return (self.session or {}).get("shift")

    def _apply_header(self):
        s = self.session or {}
        shop = (s.get("shop") or {}).get("name") or self.settings.get("shop_name") or "Online Kass"
        branch = (s.get("branch") or {}).get("name") or self.settings.get("branch_name") or ""
        term = (s.get("terminal") or {}).get("name") or self.settings.get("terminal_name") or ""
        self.root.title("%s - Online Kass" % shop)
        self.shop_lbl.configure(text=shop)
        self.place_lbl.configure(text="  ·  ".join(x for x in (branch, term) if x))
        sh = self.shift
        cashier = (sh or {}).get("cashierName") or ((s.get("cashier") or {}).get("fullName")) or self.settings.get("cashier_name") or ""
        self.cashier_lbl.configure(text="%s: %s" % (tr("cashier"), cashier) if cashier else "")
        totals = (sh or {}).get("totals") or {}
        self.shift_lbl.configure(text=tr("today", n=totals.get("receipts", 0), sum=fmt_money(totals.get("net", 0), self.currency)))
        self.cur_lbl.configure(text=CUR_SUFFIX.get(self.currency, {}).get(LANG, self.currency))

    def _set_online(self, online):
        self.online = online
        if online is None:
            self.online_lbl.configure(text="●  …", fg=C["deep_text"], bg=C["deep"])
        elif online:
            self.online_lbl.configure(text="●  " + tr("online"), fg="#7fe0b0", bg="#0a5462")
        else:
            self.online_lbl.configure(text="●  " + tr("offline"), fg="#ffb9b1", bg="#5a2a2f")

    def _scanner_state(self, state, info):
        self.scanner_state = (state, info)
        dot = {"connected": C["success"], "keyboard": C["primary"], "searching": C["warn"], "error": C["danger"]}.get(state, C["muted"])
        text = {"connected": info, "keyboard": tr("keyboard"), "searching": tr("searching"), "error": tr("not_connected")}.get(state, "")
        self.scanner_lbl.configure(text="● %s: %s" % (tr("scanner"), text), fg=dot)
        if state == "error" and info:
            log.info("scanner: %s", info)

    def _update_footer(self):
        pr = self.settings.get("printer") or {}
        kind = pr.get("type") or "none"
        target = {"windows": pr.get("name") or "default", "serial": pr.get("port") or "?", "network": pr.get("host") or "?", "file": "printed.txt", "none": tr("type_none")}.get(kind, kind)
        color = C["danger"] if self.printer_note else C["muted"]
        self.printer_lbl.configure(text="● %s: %s%s" % (tr("printer"), target, (" - " + self.printer_note) if self.printer_note else ""), fg=color)
        n = self.outbox.count()
        self.queue_lbl.configure(text=tr("queue", n=n) if n else "")
        self.receipt_lbl.configure(text=tr("last_receipt", n=self.last_number) if self.last_number else "")

    def flash(self, text, kind="info"):
        color = {"info": C["fg"], "ok": C["success"], "error": C["danger"], "warn": C["warn"]}[kind]
        self.msg_lbl.configure(text=text, fg=color)
        if kind == "error":
            beep()

    # ------------------------------------------------------------------ cart view

    def totals(self):
        subtotal = sum(line_gross(l["qty"], l["product"]["price"]) for l in self.cart)
        q = self.quote if (self.quote and self.quote.get("_v") == self.version) else None
        if q:
            return q["subtotal"], q["discount"], q["total"], q
        return subtotal, 0, subtotal, None

    def render(self, keep=None):
        sel = keep if keep is not None else self._selected()
        self.tree.delete(*self.tree.get_children())
        subtotal, discount, total, q = self.totals()
        cur = self.currency
        for i, l in enumerate(self.cart):
            p = l["product"]
            gross = line_gross(l["qty"], p["price"])
            disc = q["lines"][i]["discount"] if q else 0
            name = p["name"] + ("   [DM]" if l.get("marking") else "") + (("   - " + q["lines"][i]["promotion"]) if q and q["lines"][i].get("promotion") else "")
            tags = ["odd"] if i % 2 else []
            if disc:
                tags.append("promo")
            self.tree.insert("", "end", iid=str(i), values=(i + 1, name, fmt_qty(l["qty"]), fmt_amount(p["price"], cur), fmt_amount(gross - disc, cur)), tags=tags)
        if self.cart:
            self.empty_lbl.place_forget()
            idx = min(sel if sel is not None else len(self.cart) - 1, len(self.cart) - 1)
            self.tree.selection_set(str(idx))
            self.tree.see(str(idx))
        else:
            self.empty_lbl.place(relx=0.5, rely=0.5, anchor="center")
        self.total_lbl.configure(text=fmt_amount(total, cur))
        items = len(self.cart)
        parts = ["%s: %d" % (tr("items"), items)]
        if discount:
            parts.append("%s: %s   %s: -%s" % (tr("subtotal"), fmt_amount(subtotal, cur), tr("discount"), fmt_amount(discount, cur)))
        elif self.cart and not q and self.online is False:
            parts.append(tr("estimate"))
        self.sub_lbl.configure(text="\n".join(parts))
        self._update_buttons()
        self._update_footer()

    def _update_buttons(self):
        selling = not self.busy
        has = bool(self.cart)
        for b in (self.cash_btn, self.card_btn):
            set_enabled(b, selling and has)
        for b in (self.clear_btn, self.minus_btn, self.plus_btn, self.qty_btn, self.remove_btn):
            set_enabled(b, has and not self.busy)
        set_enabled(self.reprint_btn, self.last_doc is not None and not self.busy)

    def _selected(self):
        s = self.tree.selection() if hasattr(self, "tree") else ()
        return int(s[0]) if s else None

    def _move_sel(self, d):
        if not self.cart:
            return "break"
        i = self._selected()
        i = max(0, min(len(self.cart) - 1, (i if i is not None else 0) + d))
        self.tree.selection_set(str(i))
        self.tree.see(str(i))
        return "break"

    def changed(self, keep=None):
        self.version += 1
        self.change_lbl.configure(text="")
        self.render(keep)
        if self._quote_job:
            self.root.after_cancel(self._quote_job)
        self._quote_job = self.root.after(250, self._request_quote) if self.cart else None

    def _request_quote(self):
        self._quote_job = None
        if not self.cart or not self.api.configured:
            return
        v = self.version
        lines = [{"productId": l["product"]["id"], "qty": l["qty"]} for l in self.cart]

        def done(q):
            if q and v == self.version:
                q["_v"] = v
                self.quote = q
                self.render()

        self.bg(lambda: self.api.call("POST", "/quote", {"lines": lines}, timeout=6), done, lambda e: None)

    # ------------------------------------------------------------------ scanning

    def _entry_enter(self, _e=None):
        code = self.entry.get()
        self.entry.delete(0, "end")
        self._toggle_hint()
        if code.strip():
            self.on_code(code)
        return "break"

    def on_code(self, raw):
        code = clean_code(raw)
        if not code:
            return
        if self.root.grab_current() is not None or self.busy:
            beep()
            return
        product, marking = self.catalog.find(code)
        if product is None and self.api.configured:
            self.flash("… " + code, "info")
            self.bg(lambda: self.api.call("GET", "/lookup?code=" + urllib.parse.quote(code, safe=""), timeout=6),
                    lambda r: self._lookup_done(code, r), lambda e: self._lookup_done(code, None, e))
            return
        self._add(product, marking, code)

    def _lookup_done(self, code, r, err=None):
        if r and r.get("product"):
            p = r["product"]
            self.catalog.by_id[p["id"]] = p
            for b in p.get("barcodes") or []:
                self.catalog.by_code[b] = p
            self._add(p, r.get("markingCode"), code)
        elif isinstance(err, NetworkError) or err is None or (isinstance(err, ApiError) and err.status == 404):
            self._add(None, code_variants(code)[1], code)
        else:
            self._show_error(err)

    def _add(self, p, marking, code):
        if self.pending_marked is not None:
            want = self.pending_marked
            if marking and (p is None or p["id"] == want["id"]):
                p = want
            elif p is None or p["id"] == want["id"]:
                self.flash(tr("scan_marking", name=want["name"]), "warn")
                return
        if p is None:
            self.flash(tr("not_found", code=code), "error")
            return
        if p.get("price") is None:
            self.flash(tr("no_price", name=p["name"]), "error")
            return
        if p.get("isMarked"):
            if not marking:
                self.pending_marked = p
                self.flash(tr("scan_marking", name=p["name"]), "warn")
                return
            if any(l.get("marking") == marking for l in self.cart):
                self.pending_marked = None
                self.flash(tr("marking_used"), "error")
                return
            self.cart.append({"product": p, "qty": 1, "marking": marking})
            idx = len(self.cart) - 1
        elif p.get("isWeighted"):
            self.pending_marked = None
            self.ask_qty(product=p)
            return
        else:
            idx = next((i for i, l in enumerate(self.cart) if l["product"]["id"] == p["id"] and not l.get("marking")), None)
            if idx is None:
                self.cart.append({"product": p, "qty": 1})
                idx = len(self.cart) - 1
            else:
                self.cart[idx]["qty"] += 1
        self.pending_marked = None
        self.flash(tr("added", name=p["name"], price=fmt_money(p["price"], self.currency)), "ok")
        self.changed(idx)

    def change_qty(self, d):
        i = self._selected()
        if i is None or self.busy:
            return
        l = self.cart[i]
        if l.get("marking"):
            return  # a marked unit is always one line per package
        q = l["qty"] + d
        if q <= 0:
            self.remove_line()
            return
        l["qty"] = q
        self.changed(i)

    def remove_line(self):
        i = self._selected()
        if i is None or self.busy:
            return
        del self.cart[i]
        self.changed(max(0, i - 1) if self.cart else None)

    def clear_cart(self):
        if self.root.grab_current() is not None or not self.cart or self.busy:
            return
        if messagebox.askyesno("Online Kass", tr("confirm_clear"), parent=self.root):
            self._record_cleared(self.cart)
            self.cart = []
            self.pending_marked = None
            self.changed()
        self.focus_scan()

    def _record_cleared(self, cart):
        """Keeps the cleared receipt for the History (sent to the server in the background)."""
        try:
            lines = [{"productId": l["product"]["id"], "name": l["product"]["name"], "qty": l["qty"], "price": l["product"].get("price") or 0} for l in cart]
            if not lines:
                return
            _, _, total, _ = self.totals()
            self.declined.add({"clientEventId": uuid.uuid4().hex, "lines": lines, "total": int(total or 0), "createdAt": _now_iso()})
        except Exception:
            log.exception("could not record the cleared receipt")

    def ask_qty(self, product=None):
        if self.busy or self.root.grab_current() is not None:
            return
        i = None
        if product is None:
            i = self._selected()
            if i is None or self.cart[i].get("marking"):
                return
            product = self.cart[i]["product"]
        d = Modal(self, tr("qty"))
        d.heading(product["name"], tr("weight_prompt", name=product["name"], unit=product.get("unit") or ""))
        e = d.amount_entry(fmt_qty(self.cart[i]["qty"]) if i is not None else "1")
        e.pack(fill="x", pady=(14, 0))

        def ok():
            try:
                q = float(e.get().replace(",", ".").replace(" ", ""))
            except ValueError:
                q = 0
            if q <= 0 or q > 100000:
                e.configure(highlightbackground=C["danger"])
                return
            q = round(q, 3)
            d.close()
            if i is not None:
                self.cart[i]["qty"] = q
                self.changed(i)
            else:
                self.cart.append({"product": product, "qty": q})
                self.flash(tr("added", name=product["name"], price=fmt_money(product["price"], self.currency)), "ok")
                self.changed(len(self.cart) - 1)

        d.footer(tr("confirm"), ok)
        d.show(e)

    # ------------------------------------------------------------------ paying

    def pay(self, method):
        if not self.cart or self.busy or self.root.grab_current() is not None:
            return
        _, _, total, _ = self.totals()
        cur = self.currency
        if method == "card":
            d = Modal(self, tr("card"))
            d.heading(fmt_money(total, cur), tr("card_confirm", amount=fmt_money(total, cur)))
            d.footer(tr("confirm"), lambda: (d.close(), self.finish_sale("card", None)))
            d.show()
            return
        d = Modal(self, tr("cash"))
        d.heading("%s: %s" % (tr("to_pay"), fmt_money(total, cur)))
        tk.Label(d, text=tr("given"), bg=C["surface"], fg=C["muted"], font=F["label"], anchor="w").pack(fill="x", pady=(14, 4))
        e = d.amount_entry(fmt_amount(total, cur).replace(" ", ""))
        e.pack(fill="x")
        quick = tk.Frame(d, bg=C["surface"])
        quick.pack(fill="x", pady=(10, 0))
        steps = (1000, 5000, 10000, 50000, 100000) if cur == "UZS" else (1, 5, 10, 20, 50, 100)
        options = []
        for st in steps:
            v = ((total // 100 + st - 1) // st) * st * 100
            if v > total and v not in options:
                options.append(v)
        for v in [total] + options[:4]:
            make_button(quick, tr("exact") if v == total else fmt_amount(v, cur), lambda v=v: (e.delete(0, "end"), e.insert(0, fmt_amount(v, cur).replace(" ", "")), update()), "ghost", "sm").pack(side="left", padx=(0, 6))
        change = tk.Label(d, bg=C["surface"], fg=C["success"], font=F["title"], anchor="w")
        change.pack(fill="x", pady=(14, 0))

        def update(_e=None):
            g = parse_money(e.get())
            if g is None or g < total:
                change.configure(text=tr("insufficient"), fg=C["danger"])
            else:
                change.configure(text="%s: %s" % (tr("change"), fmt_money(g - total, cur)), fg=C["success"])

        def ok():
            g = parse_money(e.get())
            if g is None or g < total:
                update()
                beep()
                return
            d.close()
            self.finish_sale("cash", g)

        e.bind("<KeyRelease>", update)
        update()
        d.footer(tr("confirm") + "  (Enter)", ok, "accent")
        d.show(e)

    def finish_sale(self, method, given):
        self.busy = True
        self.flash(tr("saving"), "info")
        self._update_buttons()
        snapshot = [dict(l) for l in self.cart]
        lines = []
        for l in snapshot:
            row = {"productId": l["product"]["id"], "qty": l["qty"]}
            if l.get("marking"):
                row["markingCode"] = l["marking"]
            lines.append(row)
        body = {"clientRequestId": uuid.uuid4().hex, "lines": lines, "method": method}
        if method == "cash":
            body["cashGiven"] = given
        printer = dict(self.settings.get("printer") or {})
        session = self.session or {}
        fiscal = bool((session.get("shop") or {}).get("fiscalEnabled", self.settings.get("fiscal")))

        def work():
            offline = False
            try:
                res = self.api.call("POST", "/sales", body, timeout=40)
                receipt = res["receipt"]
            except NetworkError:
                if fiscal:
                    raise NetworkError(tr("fiscal_offline"))
                offline = True
                total = sum(line_gross(l["qty"], l["product"]["price"]) for l in snapshot)
                for row, l in zip(lines, snapshot):
                    row["price"] = l["product"]["price"]
                body.update(isOffline=True, createdAt=_now_iso(), localNumber=self.outbox.next_number())
                if method == "card":
                    body.pop("cashGiven", None)
                self.outbox.add(body)
                receipt = self._offline_receipt(body, snapshot, total, session)
                res = {"sale": {"number": body["localNumber"], "total": total, "change": receipt.get("change") or 0}}
            doc = render_receipt(receipt, printer)
            perr = None
            try:
                send_to_printer(doc, printer)
            except PrinterError as e:
                perr = str(e)
                log.error("printing failed: %s", e)
            return res, doc, offline, perr

        self.bg(work, self._sale_done, self._sale_failed)

    def _offline_receipt(self, body, snapshot, total, session):
        lang = ((session.get("shop") or {}).get("receiptLanguage")) or LANG
        cur = self.currency
        given = body.get("cashGiven") or 0
        return {
            "type": "sale", "language": lang, "labels": RECEIPT_LABELS.get(lang, RECEIPT_LABELS["en"]), "currency": cur,
            "shop": {"name": (session.get("shop") or {}).get("name") or self.settings.get("shop_name") or ""},
            "branch": {"name": (session.get("branch") or {}).get("name") or self.settings.get("branch_name") or ""},
            "header": TEXT.get(lang, TEXT["en"])["offline_receipt"],
            "number": body["localNumber"], "createdAt": datetime.now().strftime("%d.%m.%Y %H:%M"),
            "cashier": (self.shift or {}).get("cashierName") or self.settings.get("cashier_name") or "",
            "terminal": (session.get("terminal") or {}).get("name") or self.settings.get("terminal_name") or "",
            "lines": [{"name": l["product"]["name"], "qty": l["qty"], "price": l["product"]["price"], "discount": 0, "total": line_gross(l["qty"], l["product"]["price"])} for l in snapshot],
            "subtotal": total, "discount": 0, "total": total,
            "payments": [{"method": body["method"], "label": RECEIPT_LABELS.get(lang, RECEIPT_LABELS["en"])[body["method"]], "amount": total}],
            "cashGiven": given, "change": max(0, given - total) if given else 0, "qr": body["localNumber"],
        }

    def _sale_done(self, result):
        res, doc, offline, perr = result
        self.busy = False
        sale = res.get("sale") or {}
        self.cart = []
        self.quote = None
        self.last_doc = doc
        self.last_number = sale.get("number", "")
        self.printer_note = tr("printing_failed", err=perr) if perr else ""
        self.changed()
        change = sale.get("change") or 0
        self.change_lbl.configure(text="%s: %s" % (tr("change"), fmt_money(change, self.currency)) if change else "✓  " + self.last_number)
        if offline:
            self.flash(tr("saved_offline"), "warn")
        elif perr:
            self.flash(tr("printing_failed", err=perr), "error")
        else:
            self.flash(tr("sale_done", number=self.last_number), "ok")
        for w in res.get("warnings") or []:
            log.warning("sale warning: %s", w)
        if not offline:
            self.refresh_session()
        self.focus_scan()

    def _sale_failed(self, e):
        self.busy = False
        self.render()
        self._show_error(e)

    def reprint(self):
        if self.last_doc is None:
            return
        doc = self.last_doc
        pr = dict(self.settings.get("printer") or {})
        self.bg(lambda: send_to_printer(doc, pr), lambda t: self._printed(t), self._print_failed)

    def _printed(self, target):
        self.printer_note = ""
        self._update_footer()
        self.flash(tr("printed_to", target=target), "ok")

    def _print_failed(self, e):
        self.printer_note = tr("printing_failed", err=e)
        self._update_footer()
        self.flash(self.printer_note, "error")

    def open_history(self):
        if self.history_win is not None:
            try:
                self.history_win.deiconify()
                self.history_win.lift()
                self.history_win.focus_set()
                return
            except tk.TclError:
                self.history_win = None
        self.history_win = HistoryWindow(self)

    # ------------------------------------------------------------------ shift

    def refresh_session(self):
        self.bg(lambda: self.api.call("GET", "/session"), self.apply_session, self._session_failed)

    def _session_failed(self, e):
        if isinstance(e, NetworkError):
            self.flash(tr("conn_error", err=e), "warn")
        else:
            self._show_error(e)

    def apply_session(self, s):
        if not s:
            return
        self.session = s
        try:
            write_json("session.json", s)
        except OSError:
            pass
        self._apply_header()
        self.render()

    def refresh_catalog(self):
        self.bg(lambda: self.api.call("GET", "/catalog", timeout=60), self._apply_catalog, lambda e: None)

    def _apply_catalog(self, products):
        if products is None:
            return
        self.catalog.load(products)
        try:
            write_json("catalog.json", products)
        except OSError:
            pass

    # ------------------------------------------------------------------ settings

    def _ask_config(self):
        messagebox.showwarning("Online Kass", tr("not_configured"), parent=self.root)
        self.open_settings()

    def open_settings(self):
        if self.root.grab_current() is not None:
            return
        s = self.settings
        pr = dict(s.get("printer") or {})
        sc = dict(s.get("scanner") or {})
        d = Modal(self, tr("settings"))
        d.heading(tr("settings"), tr("settings_hint"))
        form = tk.Frame(d, bg=C["surface"])
        form.pack(fill="x", pady=(12, 0))
        vars_ = {}
        row = [0]

        def field(label, widget):
            tk.Label(form, text=label, bg=C["surface"], fg=C["muted"], font=F["label"], anchor="w").grid(row=row[0], column=0, sticky="w", pady=4, padx=(0, 14))
            widget.grid(row=row[0], column=1, sticky="we", pady=4)
            row[0] += 1
            return widget

        def combo(key, values, current, width=34, editable=False):
            v = tk.StringVar(value=current)
            vars_[key] = v
            return ttk.Combobox(form, textvariable=v, values=values, width=width, state="normal" if editable else "readonly", font=F["base"])

        def entry(key, current, show=None):
            v = tk.StringVar(value=str(current if current is not None else ""))
            vars_[key] = v
            return tk.Entry(form, textvariable=v, width=36, font=F["base"], relief="flat", bg=C["surface2"], highlightthickness=1, highlightbackground=C["border"], highlightcolor=C["primary"], show=show or "")

        langs = {"uz": "O'zbekcha", "ru": "Русский", "en": "English"}
        field(tr("language"), combo("language", list(langs.values()), langs.get(s.get("language"), "O'zbekcha")))
        field(tr("api_url"), entry("api_url", s.get("api_url")))
        field(tr("api_key"), entry("api_key", s.get("api_key"), show="•"))
        ports = [p[0] for p in list_com_ports()]
        port_values = [tr("auto"), tr("port_none")] + ports
        cur_port = {"auto": tr("auto"), "none": tr("port_none")}.get(sc.get("port") or "auto", sc.get("port"))
        field(tr("port"), combo("scan_port", port_values, cur_port, editable=True))
        field(tr("baud"), combo("scan_baud", ["9600", "19200", "38400", "57600", "115200"], str(sc.get("baudrate") or 9600)))
        types = {"windows": tr("type_windows"), "serial": tr("type_serial"), "network": tr("type_network"), "file": tr("type_file"), "none": tr("type_none")}
        field(tr("printer_type"), combo("pr_type", list(types.values()), types.get(pr.get("type") or "windows")))
        printers = windows_printers()
        field(tr("printer_name"), combo("pr_name", printers, pr.get("name") or default_windows_printer(), editable=True))
        field(tr("printer_port"), combo("pr_port", ports, pr.get("port") or "", editable=True))
        field(tr("host"), entry("pr_host", pr.get("host")))
        field(tr("tcp_port"), entry("pr_tcp", pr.get("tcp_port") or 9100))
        field(tr("paper"), combo("pr_paper", ["58", "80"], str(pr.get("paper_mm") or 58)))
        field(tr("code_page"), combo("pr_cp", list(CODE_PAGE_NUMBER), pr.get("code_page") or "CP866"))
        checks = tk.Frame(form, bg=C["surface"])
        checks.grid(row=row[0], column=1, sticky="w", pady=(6, 0))
        cut_v, drawer_v = tk.BooleanVar(value=bool(pr.get("cut"))), tk.BooleanVar(value=bool(pr.get("drawer")))
        for text, var in ((tr("cut"), cut_v), (tr("drawer"), drawer_v)):
            tk.Checkbutton(checks, text=text, variable=var, bg=C["surface"], activebackground=C["surface"], font=F["base"]).pack(side="left", padx=(0, 12))

        def collect():
            inv_lang = {v: k for k, v in langs.items()}
            inv_type = {v: k for k, v in types.items()}
            port = vars_["scan_port"].get().strip()
            port = {tr("auto"): "auto", tr("port_none"): "none"}.get(port, port or "auto")
            try:
                tcp = int(vars_["pr_tcp"].get() or 9100)
            except ValueError:
                tcp = 9100
            return {
                "language": inv_lang.get(vars_["language"].get(), "uz"),
                "api_url": vars_["api_url"].get().strip(),
                "api_key": vars_["api_key"].get().strip(),
                "scanner": {"port": port, "baudrate": int(vars_["scan_baud"].get() or 9600)},
                "printer": {
                    "type": inv_type.get(vars_["pr_type"].get(), "windows"), "name": vars_["pr_name"].get().strip(),
                    "port": vars_["pr_port"].get().strip(), "baudrate": int(pr.get("baudrate") or 9600),
                    "host": vars_["pr_host"].get().strip(), "tcp_port": tcp, "paper_mm": int(vars_["pr_paper"].get() or 58),
                    "code_page": vars_["pr_cp"].get() or "CP866", "cut": bool(cut_v.get()), "drawer": bool(drawer_v.get()),
                },
            }

        def test():
            c = collect()
            prn = c["printer"]
            self.bg(lambda: send_to_printer(render_test_page(prn, self.settings), prn), lambda t: self.flash(tr("printer_ok") + " (" + t + ")", "ok"), self._print_failed)

        def save():
            c = collect()
            lang_changed = c["language"] != self.settings.get("language")
            conn_changed = (c["api_url"], c["api_key"]) != (self.settings.get("api_url"), self.settings.get("api_key"))
            self.settings = _merge(self.settings, c)
            try:
                save_settings(self.settings)
            except OSError as e:
                self._show_error(e)
                return
            d.close()
            set_language(self.settings["language"])
            self.api = Api(self.settings, self._on_online)
            self.printer_note = ""
            self.scanner.restart()
            if lang_changed:
                self.build_ui()
            if conn_changed and self.api.configured:
                self.refresh_session()
                self.refresh_catalog()
            self._update_footer()
            self.flash(tr("settings_saved"), "ok")

        row_b = tk.Frame(d, bg=C["surface"])
        row_b.pack(fill="x", pady=(18, 0))
        make_button(row_b, tr("save"), save, "primary").pack(side="right")
        make_button(row_b, tr("cancel"), d.close).pack(side="right", padx=(0, 8))
        make_button(row_b, tr("test_print"), test, "ghost").pack(side="left")
        d.show()

    # ------------------------------------------------------------------ misc

    def _show_error(self, e):
        if isinstance(e, ApiError):
            text = e.message or e.code
        elif isinstance(e, NetworkError):
            text = tr("conn_error", err=e)
        else:
            text = str(e)
        self.flash(text, "error")
        messagebox.showerror(tr("error"), text, parent=self.root)
        self.focus_scan()

    def quit(self):
        if self.cart and not messagebox.askyesno("Online Kass", tr("quit_confirm"), parent=self.root):
            return
        self.scanner.stop()
        self.root.destroy()


# ============================================================================== entry


def run_check() -> int:
    s = load_settings()
    set_language(s.get("language"))
    print("Online Kass desk %s  |  data: %s" % (VERSION, data_dir()))
    print("Server:  %s" % (s.get("api_url") or "-"))
    try:
        sess = Api(s).call("GET", "/session", timeout=8)
        shift = sess.get("shift")
        print("  OK  shop=%s  terminal=%s  shift=%s" % (sess["shop"]["name"], sess["terminal"]["name"], "open" if shift else "closed"))
    except (ApiError, NetworkError) as e:
        print("  FAIL %s" % e)
    print("COM ports:")
    for port, desc in list_com_ports() or [("-", "none found")]:
        print("  %-8s %s" % (port, desc))
    print("Windows printers: %s" % (", ".join(windows_printers()) or "-"))
    print("Default printer:  %s" % (default_windows_printer() or "-"))
    return 0


def main() -> int:
    setup_logging()
    if "--check" in sys.argv:
        return run_check()
    if "--test-print" in sys.argv:
        s = load_settings()
        pr = s.get("printer") or {}
        print(send_to_printer(render_test_page(pr, s), pr))
        return 0
    if tk is None:
        print("Tkinter is not available in this Python installation.")
        return 1
    if IS_WIN:
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(1)  # sharp text on high-DPI screens
        except Exception:
            pass
    log.info("starting Online Kass desk %s", VERSION)
    root = tk.Tk()
    DeskApp(root)
    root.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
