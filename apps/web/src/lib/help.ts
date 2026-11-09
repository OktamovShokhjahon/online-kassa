/**
 * Help for form fields: a short definition shown under the input, and a longer explanation with an
 * example shown when the "?" next to it is hovered or focused.
 *
 * Entries are keyed by the i18n key of the field's label (e.g. `shop.products.sku`). A field finds
 * its entry automatically from its label text (see `useFieldHelp`), so pages need no changes.
 * Generic labels such as "Name" or "Branch" can have a page-specific entry: `<section>:<key>`,
 * where section is the page (`products`, `terminals`, `sa-shops`, `pos`...).
 *
 * Texts are [uz, ru, en]. `e` (example) is either one value for all languages or [uz, ru, en].
 */
export type T3 = [uz: string, ru: string, en: string];
export interface HelpEntry {
  /** Short definition under the input. */
  d: T3;
  /** Longer explanation in the popover. */
  m: T3;
  /** Example value. */
  e?: string | T3;
}

export const HELP: Record<string, HelpEntry> = {
  /* ------------------------------------------------------------------------- sign in */
  'auth.login': {
    d: ['Sizga berilgan foydalanuvchi nomi', 'Имя пользователя, выданное вам', 'The user name you were given'],
    m: ['Login doʻkon egasi yoki administrator tomonidan yaratiladi. Katta-kichik harf farqlanmaydi.', 'Логин создаёт владелец магазина или администратор. Регистр букв не важен.', 'The shop owner or administrator creates it. Upper and lower case do not matter.'],
    e: 'demo.cashier',
  },
  'auth.password': {
    d: ['Hisobingiz paroli', 'Пароль вашей учётной записи', 'The password of your account'],
    m: ['Kamida 8 belgi. Parolni unutsangiz, doʻkon egasi uni Xodimlar boʻlimida yangilaydi.', 'Не менее 8 символов. Если забыли, владелец магазина сбросит его в разделе «Сотрудники».', 'At least 8 characters. If you forget it, the shop owner resets it under Staff.'],
    e: '••••••••',
  },

  /* ------------------------------------------------------------------------- common */
  'common.name': {
    d: ['Roʻyxatlarda koʻrinadigan nom', 'Название, видимое в списках', 'The name shown in lists'],
    m: ['Qisqa va tushunarli yozing: bu nom qidiruvda, hisobotlarda va chekda ishlatiladi.', 'Пишите коротко и понятно: название используется в поиске, отчётах и на чеке.', 'Keep it short and clear: it is used in search, reports and on receipts.'],
    e: ['Chilonzor filiali', 'Филиал Чиланзар', 'Chilonzor branch'],
  },
  'products:common.name': {
    d: ['Mahsulotning chekdagi nomi', 'Название товара на чеке', 'Product name as printed on the receipt'],
    m: ['Brend, nom va hajmni yozing — kassir va xaridor mahsulotni darhol tanishi uchun. Chekda 2 qatorgacha chiqadi.', 'Укажите бренд, название и объём — чтобы кассир и покупатель сразу узнали товар. На чеке до 2 строк.', 'Write brand, name and size so the cashier and the customer recognise it at once. Up to 2 lines on the receipt.'],
    e: 'Coca-Cola 1.5L',
  },
  'branches:common.name': {
    d: ['Filial (doʻkon nuqtasi) nomi', 'Название филиала (точки)', 'Name of the branch (store location)'],
    m: ['Chekda, hisobotlarda va kassa ekranida koʻrinadi. Odatda tuman yoki koʻcha nomi.', 'Видно на чеке, в отчётах и на экране кассы. Обычно район или улица.', 'Shown on receipts, in reports and on the till. Usually the district or street.'],
    e: ['Yunusobod', 'Юнусабад', 'Yunusobod'],
  },
  'categories:common.name': {
    d: ['Mahsulotlar guruhi nomi', 'Название группы товаров', 'Name of the product group'],
    m: ['Kategoriyalar mahsulotlarni tartiblaydi, hisobotlarda va aksiyalarda ishlatiladi.', 'Категории упорядочивают товары и используются в отчётах и акциях.', 'Categories organise products and are used in reports and promotions.'],
    e: ['Ichimliklar', 'Напитки', 'Drinks'],
  },
  'suppliers:common.name': {
    d: ['Yetkazib beruvchi kompaniya nomi', 'Название компании-поставщика', 'Name of the supplier company'],
    m: ['Kirim hujjatlari, qarzlar va toʻlovlar shu nom bilan yuritiladi.', 'Приходы, долги и оплаты ведутся под этим названием.', 'Goods receipts, debts and payments are kept under this name.'],
    e: '"Coca-Cola Ichimligi" MChJ',
  },
  'terminals:common.name': {
    d: ['Kassa (terminal) nomi', 'Название кассы (терминала)', 'Name of the till (terminal)'],
    m: ['Kassir ishga kirganda shu nomni tanlaydi; chekda va X/Z hisobotlarda chiqadi.', 'Кассир выбирает это название при входе; оно печатается на чеке и в X/Z-отчётах.', 'The cashier picks it when signing in; it is printed on receipts and X/Z reports.'],
    e: ['Kassa 1', 'Касса 1', 'Till 1'],
  },
  'promotions:common.name': {
    d: ['Aksiyaning chekdagi nomi', 'Название акции на чеке', 'Promotion name shown on the receipt'],
    m: ['Xaridor chekda chegirma sababini shu nom orqali koʻradi.', 'Покупатель увидит на чеке, за что скидка, по этому названию.', 'The customer sees on the receipt why they got the discount.'],
    e: ['Choy 2+1', 'Чай 2+1', 'Tea 2+1'],
  },
  'developers:common.name': {
    d: ['Kalit qayerda ishlatilishi', 'Где используется ключ', 'Where the key is used'],
    m: ['Kalitni keyin tanib olish uchun tizim nomini yozing. Bir tizim — bitta kalit.', 'Укажите название системы, чтобы потом узнать ключ. Одна система — один ключ.', 'Name the system so you recognise the key later. One system, one key.'],
    e: ['1C buxgalteriya', '1С бухгалтерия', '1C accounting'],
  },
  'settings:common.name': {
    d: ['Doʻkoningizning chekdagi nomi', 'Название магазина на чеке', 'Your shop name on receipts'],
    m: ['Chek tepasida yirik harflar bilan chiqadi va Telegram xabarlarida ishlatiladi.', 'Печатается крупно вверху чека и используется в сообщениях Telegram.', 'Printed large at the top of the receipt and used in Telegram messages.'],
    e: 'Demo Market',
  },
  'common.branch': {
    d: ['Bu maʼlumot qaysi filialga tegishli', 'К какому филиалу относится', 'Which branch this belongs to'],
    m: ['Qoldiq, narx va savdo har bir filial uchun alohida yuritiladi.', 'Остатки, цены и продажи ведутся отдельно по каждому филиалу.', 'Stock, prices and sales are kept separately for each branch.'],
    e: ['Chilonzor', 'Чиланзар', 'Chilonzor'],
  },
  'terminals:common.branch': {
    d: ['Kassa joylashgan filial', 'Филиал, где стоит касса', 'The branch where this till stands'],
    m: ['Kassa shu filial narxlari bilan sotadi va qoldiqni shu filialdan kamaytiradi.', 'Касса продаёт по ценам этого филиала и списывает остатки с него.', 'The till sells at this branch’s prices and takes stock from this branch.'],
    e: ['Chilonzor', 'Чиланзар', 'Chilonzor'],
  },
  'products:common.branch': {
    d: ['Narxi yorliqqa olinadigan filial', 'Филиал, чья цена печатается', 'Branch whose price is printed'],
    m: ['Har bir filialda narx boshqacha boʻlishi mumkin, shuning uchun yorliq qaysi filial uchun ekanini tanlang.', 'Цены в филиалах могут отличаться, поэтому выберите, для какого филиала ценник.', 'Prices can differ by branch, so choose which branch the label is for.'],
  },
  'prices:common.branch': {
    d: ['Narxlar oʻzgaradigan filial', 'Филиал, где меняются цены', 'Branch whose prices change'],
    m: ['Oʻzgarish faqat shu filial narxlariga taʼsir qiladi.', 'Изменение затронет только цены этого филиала.', 'The change only affects this branch’s prices.'],
  },
  'counts:common.branch': {
    d: ['Inventarizatsiya qilinadigan filial', 'Филиал, где идёт инвентаризация', 'Branch being counted'],
    m: ['Sanalgan miqdorlar shu filial qoldigʻi bilan solishtiriladi.', 'Подсчитанное сравнивается с остатками этого филиала.', 'Counted quantities are compared with this branch’s stock.'],
  },
  'promotions:common.branch': {
    d: ['Aksiya ishlaydigan filiallar', 'Филиалы, где действует акция', 'Branches where the promotion runs'],
    m: ['Hech biri tanlanmasa, aksiya barcha filiallarda ishlaydi.', 'Если ничего не выбрано, акция действует во всех филиалах.', 'If none is selected, the promotion runs in every branch.'],
  },
  'reports:common.branch': {
    d: ['Hisobotni filial boʻyicha cheklash', 'Ограничить отчёт филиалом', 'Limit the report to one branch'],
    m: ['"Barchasi" tanlansa, hisobot barcha filiallar boʻyicha jamlanadi.', 'При выборе «Все» отчёт собирается по всем филиалам.', 'With "All", the report covers every branch.'],
  },
  'developers:common.branch': {
    d: ['Kalitni bitta filialga bogʻlash', 'Привязать ключ к одному филиалу', 'Bind the key to one branch'],
    m: ['Bogʻlangan kalit boshqa filiallar maʼlumotini koʻra olmaydi. Hammasi uchun boʻsh qoldiring.', 'Привязанный ключ не видит другие филиалы. Для всех — оставьте пустым.', 'A bound key cannot see other branches. Leave empty for all.'],
  },
  'common.active': {
    d: ['Oʻchirilsa, yangi ishlarda koʻrinmaydi', 'Если выключить, не используется дальше', 'When off, it is no longer used'],
    m: ['Maʼlumot oʻchirilmaydi: tarix va hisobotlar saqlanadi, faqat yangi savdo va hujjatlarda tanlab boʻlmaydi.', 'Данные не удаляются: история и отчёты остаются, просто его нельзя выбрать в новых продажах и документах.', 'Nothing is deleted: history and reports stay; it just cannot be picked in new sales or documents.'],
  },
  'common.amount': {
    d: ['Pul miqdori', 'Сумма денег', 'Amount of money'],
    m: ['Soʻmda butun son yoki tiyin bilan kiriting; boʻshliqlar ixtiyoriy.', 'Вводите в сумах целым числом или с тийинами; пробелы можно не ставить.', 'Enter in the shop currency; spaces are optional.'],
    e: '250 000',
  },
  'common.comment': {
    d: ['Qisqa izoh (ixtiyoriy)', 'Короткий комментарий (необязательно)', 'Short comment (optional)'],
    m: ['Keyinchalik nima uchun qilinganini eslash uchun yozing. Tarixda koʻrinadi.', 'Напишите, чтобы потом вспомнить причину. Видно в истории.', 'Write why, so you remember later. It shows in the history.'],
    e: ['Noyabr uchun toʻlov', 'Оплата за ноябрь', 'Payment for November'],
  },
  'common.currency': {
    d: ['Doʻkon hisob-kitob valyutasi', 'Валюта учёта магазина', 'Currency the shop works in'],
    m: ['Birinchi savdodan keyin valyutani oʻzgartirib boʻlmaydi — hisobotlar aralashib ketmasligi uchun.', 'После первой продажи валюту изменить нельзя, чтобы не смешались отчёты.', 'It cannot be changed after the first sale so reports stay consistent.'],
    e: 'UZS',
  },
  'common.date': {
    d: ['Hujjat sanasi', 'Дата документа', 'Date of the document'],
    m: ['Odatda bugungi sana. Oʻtgan sana bilan kiritish mumkin.', 'Обычно сегодняшняя дата. Можно указать прошедшую.', 'Usually today. A past date can be entered.'],
    e: '07.11.2026',
  },
  'common.from': {
    d: ['Davr boshlanishi', 'Начало периода', 'Start of the period'],
    m: ['Shu kun ham davrga kiradi (Toshkent vaqti bilan).', 'Этот день включается в период (время Ташкента).', 'This day is included (Tashkent time).'],
    e: '01.11.2026',
  },
  'common.to': {
    d: ['Davr tugashi', 'Конец периода', 'End of the period'],
    m: ['Shu kun oxirigacha hisobga olinadi.', 'Учитывается до конца этого дня.', 'Counted up to the end of this day.'],
    e: '30.11.2026',
  },
  'common.language': {
    d: ['Interfeys va xabarlar tili', 'Язык интерфейса и сообщений', 'Language of the interface and messages'],
    m: ['Foydalanuvchi tizimga kirganda shu tilda koʻradi; Telegram xabarlari ham shu tilda keladi.', 'Пользователь видит систему на этом языке; сообщения Telegram тоже.', 'The user sees the system in this language; Telegram messages too.'],
    e: ['Oʻzbekcha', 'Русский', 'English'],
  },
  'common.note': {
    d: ['Ichki eslatma (ixtiyoriy)', 'Внутренняя заметка (необязательно)', 'Internal note (optional)'],
    m: ['Faqat panelda koʻrinadi, chekka chiqmaydi.', 'Видна только в панели, на чек не печатается.', 'Only visible in the panel, never printed.'],
    e: ['Ulgurji mijoz', 'Оптовый клиент', 'Wholesale customer'],
  },
  'sa-shops:common.note': {
    d: ['Faqat platforma egasi koʻradi', 'Видит только владелец платформы', 'Only the platform owner sees it'],
    m: ['Doʻkon bilan kelishuvlar, chegirmalar yoki aloqa tafsilotlarini yozing.', 'Записывайте договорённости с магазином, скидки или контакты.', 'Keep agreements, discounts or contact details for this shop.'],
    e: ['Yillik toʻlov, 10% chegirma', 'Годовая оплата, скидка 10%', 'Pays yearly, 10% discount'],
  },
  'common.phone': {
    d: ['Telefon raqami', 'Номер телефона', 'Phone number'],
    m: ['Xalqaro formatda kiriting; boʻshliq va qavslar avtomatik olib tashlanadi.', 'В международном формате; пробелы и скобки убираются автоматически.', 'International format; spaces and brackets are removed automatically.'],
    e: '+998 90 123 45 67',
  },
  'common.reason': {
    d: ['Amal sababi', 'Причина действия', 'Reason for the action'],
    m: ['Sabab audit jurnaliga yoziladi va doʻkonga koʻrsatiladi.', 'Причина записывается в журнал аудита и видна магазину.', 'The reason is written to the audit log and shown to the shop.'],
    e: ['Toʻlov 30 kun kechikdi', 'Оплата просрочена на 30 дней', 'Payment 30 days overdue'],
  },

  /* ---------------------------------------------------------------------------- POS */
  'pos.openingCash': {
    d: ['Smena boshida kassadagi naqd pul', 'Наличные в кассе на начало смены', 'Cash in the drawer when the shift starts'],
    m: ['Mayda pullarni sanab kiriting. Smena yopilganda kutilgan summa shundan hisoblanadi.', 'Пересчитайте размен и введите сумму. От неё считается ожидаемая сумма при закрытии.', 'Count the change float. The expected cash at closing starts from it.'],
    e: '200 000',
  },
  'pos.cash.amount': {
    d: ['Kiritiladigan yoki olinadigan summa', 'Сумма внесения или изъятия', 'Amount put in or taken out'],
    m: ['Savdosiz kassaga pul qoʻyish yoki olish. Smena hisobotida alohida koʻrinadi.', 'Внесение или изъятие денег без продажи. Отдельно видно в отчёте смены.', 'Cash put in or taken out without a sale. Shown separately in the shift report.'],
    e: '500 000',
  },
  'pos.cash.comment': {
    d: ['Nima uchun pul kiritildi yoki olindi', 'Зачем внесли или изъяли деньги', 'Why cash was put in or taken out'],
    m: ['Egasi hisobotda sababni koʻradi.', 'Владелец увидит причину в отчёте.', 'The owner sees the reason in the report.'],
    e: ['Inkassatsiya', 'Инкассация', 'Cash collection'],
  },
  'pos.method.cash': {
    d: ['Xaridor bergan naqd pul', 'Наличные от покупателя', 'Cash handed over by the customer'],
    m: ['Chek summasidan koʻp boʻlsa, qaytim avtomatik hisoblanadi.', 'Если больше суммы чека, сдача посчитается автоматически.', 'If more than the total, the change is calculated for you.'],
    e: '100 000',
  },
  'pos.method.card': {
    d: ['Karta orqali toʻlangan summa', 'Сумма оплаты картой', 'Amount paid by card'],
    m: ['Avval terminalda toʻlovni oʻtkazing, keyin shu yerga summani kiriting.', 'Сначала проведите оплату на терминале, затем введите сумму здесь.', 'Charge the card terminal first, then enter the amount here.'],
    e: '45 000',
  },
  'pos.method.credit': {
    d: ['Mijoz qarziga yoziladigan summa', 'Сумма в долг покупателю', 'Amount put on the customer’s debt'],
    m: ['Faqat tanlangan mijoz uchun va uning kredit limiti doirasida.', 'Только для выбранного клиента и в пределах его кредитного лимита.', 'Only for a selected customer and within their credit limit.'],
    e: '30 000',
  },
  'pos.receiptDiscount': {
    d: ['Butun chekka chegirma', 'Скидка на весь чек', 'Discount on the whole receipt'],
    m: ['Limitdan katta chegirma uchun menejer PIN kodi kerak.', 'Для скидки выше лимита нужен PIN менеджера.', 'A discount above your limit needs a manager’s PIN.'],
    e: '5 000',
  },
  'pos.refund.method': {
    d: ['Pul qanday qaytariladi', 'Как вернуть деньги', 'How the money is returned'],
    m: ['Odatda xaridor qanday toʻlagan boʻlsa, shunday qaytaring.', 'Обычно возвращайте тем же способом, которым платили.', 'Usually refund the way the customer paid.'],
    e: ['Naqd', 'Наличные', 'Cash'],
  },
  'pos.refund.reason': {
    d: ['Qaytarish sababi', 'Причина возврата', 'Reason for the return'],
    m: ['Hisobotda va audit jurnalida saqlanadi.', 'Сохраняется в отчёте и журнале аудита.', 'Kept in reports and the audit log.'],
    e: ['Muddati oʻtgan', 'Истёк срок годности', 'Expired'],
  },
  'pos.refundGoods': {
    d: ['Qaytarilayotgan miqdorlar', 'Возвращаемые количества', 'Quantities being returned'],
    m: ['Har bir mahsulot uchun qaytariladigan sonni kiriting; sotilganidan koʻp boʻlmaydi.', 'Укажите количество по каждому товару; не больше проданного.', 'Enter the quantity for each item; not more than was sold.'],
    e: '1',
  },
  'pos.close.counted': {
    d: ['Kassada sanalgan haqiqiy naqd pul', 'Фактически пересчитанные наличные', 'Cash actually counted in the drawer'],
    m: ['Kutilgan summa bilan farq Z-hisobotda koʻrinadi va egasiga xabar qilinadi.', 'Разница с ожидаемой суммой видна в Z-отчёте и сообщается владельцу.', 'The difference from the expected cash shows in the Z-report and is sent to the owner.'],
    e: '1 245 000',
  },
  'pos.fullName': {
    d: ['Mijozning ismi va familiyasi', 'Имя и фамилия клиента', 'Customer’s full name'],
    m: ['Bonus va qarzlar shu mijozga yoziladi.', 'Бонусы и долги записываются на этого клиента.', 'Bonuses and debts are recorded for this customer.'],
    e: 'Aziz Karimov',
  },

  /* ---------------------------------------------------------------------- products */
  'shop.products.sku': {
    d: ['Ichki artikul (ixtiyoriy)', 'Внутренний артикул (необязательно)', 'Internal article number (optional)'],
    m: ['Yetkazib beruvchi katalogidagi kod yoki oʻzingizning raqamingiz. Kassada qidiruvda ishlaydi.', 'Код из каталога поставщика или ваш номер. Ищется на кассе.', 'A supplier catalogue code or your own number. Searchable at the till.'],
    e: 'CC-150',
  },
  'shop.products.category': {
    d: ['Mahsulot guruhi', 'Группа товара', 'Product group'],
    m: ['Hisobotlarda, aksiyalarda va inventarizatsiyada ishlatiladi.', 'Используется в отчётах, акциях и инвентаризации.', 'Used in reports, promotions and stock counts.'],
    e: ['Ichimliklar › Gazli', 'Напитки › Газированные', 'Drinks › Soft drinks'],
  },
  'shop.products.unit': {
    d: ['Qanday oʻlchovda sotiladi', 'В чём продаётся', 'How it is sold'],
    m: ['Dona, kg, litr... Tarozida sotilsa, "kg" ni tanlang va "Tortiladigan" belgisini qoʻying.', 'Штуки, кг, литры... Для весового товара выберите «кг» и отметьте «Весовой».', 'Piece, kg, litre... For goods sold by weight choose kg and tick "Weighted".'],
    e: ['dona', 'шт', 'piece'],
  },
  'shop.products.vat': {
    d: ['QQS stavkasi, %', 'Ставка НДС, %', 'VAT rate, %'],
    m: ['Narx ichidagi QQS chekda alohida koʻrsatiladi. QQS toʻlamasangiz, boʻsh qoldiring.', 'НДС в цене показывается на чеке отдельно. Если не платите НДС — оставьте пустым.', 'VAT included in the price is shown on the receipt. Leave empty if you do not pay VAT.'],
    e: '12',
  },
  'shop.products.barcodes': {
    d: ['Skaner oʻqiydigan kodlar', 'Коды, которые читает сканер', 'Codes the scanner reads'],
    m: ['Yangi mahsulot uchun ichki EAN-13 kod va QR kod avtomatik yaratiladi. Zavod kodini skanerlab qoʻshishingiz ham mumkin; bitta mahsulotda bir nechta kod boʻlishi mumkin.', 'Для нового товара внутренний EAN-13 и QR-код создаются автоматически. Можно отсканировать и добавить заводской код; у товара может быть несколько кодов.', 'A new product gets an internal EAN-13 and a QR code automatically. You can also scan the factory code; one product can have several codes.'],
    e: '4780000000013',
  },
  'shop.products.salePrice': {
    d: ['Xaridor toʻlaydigan narx', 'Цена, которую платит покупатель', 'The price the customer pays'],
    m: ['Barcha filiallarga qoʻyiladi. Har bir filialda boshqa narx kerak boʻlsa, «Qoʻshimcha sozlamalar»ni oching.', 'Ставится во всех филиалах. Если нужна своя цена в каждом филиале — откройте «Дополнительно».', 'Applied in every branch. For a different price per branch, open "More settings".'],
    e: '12 000',
  },
  'shop.products.costPrice': {
    d: ['Mahsulotni necha soʻmga olgansiz', 'За сколько вы купили товар', 'What you paid for one unit'],
    m: ['Foyda = sotuv narxi − tannarx. Hisobotlar va boshqaruv panelidagi foyda shundan hisoblanadi. Xodimlar va kassirlar buni koʻrmaydi.', 'Прибыль = цена продажи − себестоимость. По ней считается прибыль в отчётах и на главной. Кассиры её не видят.', 'Profit = selling price − cost price. Profit in reports and on the dashboard comes from it. Cashiers never see it.'],
    e: '9 000',
  },
  /* ----------------------------------------------------------------- warehouse (Ombor) */
  'shop.warehouse.supplier': {
    d: ['Mahsulotni kim olib keldi (ixtiyoriy)', 'Кто привёз товар (необязательно)', 'Who delivered the goods (optional)'],
    m: ['«Yetkazib beruvchilar» sahifasida qoʻshilgan odam yoki firma. Bilmasangiz, «Koʻrsatilmagan» qoldiring: kirim baribir saqlanadi.', 'Человек или фирма со страницы «Поставщики». Если не знаете — оставьте «Не указан»: приход всё равно сохранится.', 'A person or company from the Suppliers page. If you do not know, leave "Not specified": the arrival is saved anyway.'],
    e: ['Akmal (Coca-Cola)', 'Акмал (Coca-Cola)', 'Akmal (Coca-Cola)'],
  },
  'shop.warehouse.addProduct': {
    d: ['Kelgan mahsulotni qidirib tanlang', 'Найдите и выберите поступивший товар', 'Find and pick the product that arrived'],
    m: ['Faqat «Mahsulotlar» sahifasida yaratilgan mahsulotlarni tanlash mumkin. Shtrix-kodni skanerlasangiz ham topiladi. Bir kirimga bir nechta mahsulot qoʻshish mumkin.', 'Можно выбрать только товары, созданные на странице «Товары». Можно отсканировать штрихкод. В один приход можно добавить несколько товаров.', 'Only products created on the Products page can be picked. Scanning a barcode finds it too. One arrival can hold several products.'],
    e: ['Coca-Cola 1L', 'Coca-Cola 1L', 'Coca-Cola 1L'],
  },
  'shop.warehouse.quantity': {
    d: ['Nechta (kg, litr) keldi', 'Сколько пришло (шт, кг, л)', 'How many (pcs, kg, l) arrived'],
    m: ['Tortiladigan mahsulot uchun kasr son kiriting.', 'Для весового товара можно ввести дробное число.', 'Use a decimal for weighed goods.'],
    e: '24',
  },
  'shop.warehouse.unitCost': {
    d: ['Bittasini necha soʻmga oldingiz', 'Сколько стоила одна единица', 'What one unit cost you'],
    m: ['Mahsulotning tannarxi avtomatik qoʻyiladi, oʻzgartirish mumkin. Kirim summasi = miqdor × narx.', 'Подставляется себестоимость товара, её можно изменить. Сумма прихода = количество × цена.', 'Filled from the product cost price; you can change it. Arrival amount = quantity × cost.'],
    e: '9 000',
  },
  'shop.warehouse.updateCostPrice': {
    d: ['Foyda yangi narx bilan hisoblanadi', 'Прибыль будет считаться по новой цене', 'Profit will use the new cost'],
    m: ['Belgilansa, har bir mahsulotning «Tannarx»i shu kirimdagi narxga oʻzgaradi va keyingi sotuvlar foydasi shu bilan hisoblanadi. Faqat doʻkon egasi uchun.', 'Если отмечено, «Себестоимость» каждого товара станет ценой из этого прихода, и прибыль следующих продаж считается по ней. Только для владельца.', 'When ticked, each product’s cost price becomes the cost in this arrival and profit on later sales uses it. Shop owner only.'],
  },
  'shop.products.extraBarcode': {
    d: ['Zavod kodi yoki ikkinchi kod', 'Заводской или второй код', 'Factory code or a second code'],
    m: ['Mahsulot qadogʻidagi shtrix-kodni skanerlang: kassada ikkala kod ham shu mahsulotni topadi.', 'Отсканируйте штрихкод на упаковке: на кассе оба кода найдут этот товар.', 'Scan the code on the package: at the till both codes find this product.'],
    e: '4780000000013',
  },
  'shop.products.mxik': {
    d: ['Soliq tasniflagichidagi kod (17 raqam)', 'Код ИКПУ из классификатора (17 цифр)', 'Tax classifier code (17 digits)'],
    m: ['Fiskal cheklar uchun majburiy. tasnif.soliq.uz saytidan topiladi.', 'Обязателен для фискальных чеков. Ищется на tasnif.soliq.uz.', 'Required for fiscal receipts. Find it on tasnif.soliq.uz.'],
    e: '02202001001000000',
  },
  'shop.products.packageCode': {
    d: ['Qadoq birligi kodi', 'Код единицы упаковки', 'Package unit code'],
    m: ['MXIK kodiga bogʻlangan oʻlchov birligi kodi; fiskal cheklar uchun kerak.', 'Код единицы измерения, связанный с ИКПУ; нужен для фискальных чеков.', 'Unit code linked to the MXIK code; needed for fiscal receipts.'],
    e: '1500',
  },
  'shop.products.pricesByBranch': {
    d: ['Har bir filialdagi sotuv narxi', 'Цена продажи в каждом филиале', 'Selling price in each branch'],
    m: ['Narxsiz mahsulotni kassada sotib boʻlmaydi. Narxni faqat doʻkon egasi oʻzgartiradi.', 'Товар без цены нельзя продать. Цену меняет только владелец.', 'A product without a price cannot be sold. Only the owner changes prices.'],
    e: '12 000',
  },
  'shop.products.weighted': {
    d: ['Tarozida tortib sotiladi', 'Продаётся на развес', 'Sold by weight'],
    m: ['Kassada miqdor kasr son boʻlishi mumkin (masalan 0.750 kg).', 'На кассе количество может быть дробным (например 0,750 кг).', 'At the till the quantity can be fractional (e.g. 0.750 kg).'],
  },
  'shop.products.marked': {
    d: ['Majburiy markirovkali mahsulot', 'Товар с обязательной маркировкой', 'Goods with mandatory marking'],
    m: ['Har bir dona sotilganda qadoqdagi DataMatrix kod skanerlanishi shart (Asl belgisi).', 'При продаже каждой единицы нужно сканировать DataMatrix на упаковке (Asl belgisi).', 'Each unit sold needs its DataMatrix code scanned (Asl belgisi).'],
  },
  'shop.products.image': {
    d: ['Mahsulot rasmi, 2 MB gacha', 'Фото товара, до 2 МБ', 'Product photo, up to 2 MB'],
    m: ['PNG, JPG yoki WEBP. Kassada qidiruvda tanib olishga yordam beradi.', 'PNG, JPG или WEBP. Помогает узнать товар в поиске на кассе.', 'PNG, JPG or WEBP. Helps recognise the product in the till search.'],
  },
  'shop.products.copies': {
    d: ['Nechta yorliq chop etiladi', 'Сколько ценников печатать', 'How many labels to print'],
    m: ['Odatda javondagi mahsulotlar soni.', 'Обычно столько, сколько товара на полке.', 'Usually as many as there are on the shelf.'],
    e: '10',
  },
  'shop.products.priceBranches': {
    d: ['Fayldagi narx qaysi filiallarga yoziladi', 'В какие филиалы записать цены из файла', 'Branches that get the prices from the file'],
    m: ['Belgilangan har bir filialga bir xil narx qoʻyiladi.', 'В каждый отмеченный филиал запишется одна и та же цена.', 'Each ticked branch gets the same price.'],
  },
  'shop.products.updateExisting': {
    d: ['Bor mahsulotlarni yangilash', 'Обновлять существующие товары', 'Update products that already exist'],
    m: ['Shtrix-kodi yoki artikuli mos kelgan mahsulotlar fayldagi maʼlumot bilan yangilanadi; aks holda oʻtkazib yuboriladi.', 'Товары с совпадающим штрихкодом или артикулом обновятся данными из файла; иначе будут пропущены.', 'Products with a matching barcode or SKU are updated from the file; otherwise skipped.'],
  },
  'shop.products.col.name': { d: ['Nom ustuni', 'Столбец с названием', 'Column with the name'], m: ['Fayldagi qaysi ustunda mahsulot nomi turibdi.', 'В каком столбце файла название товара.', 'Which column of your file holds the product name.'], e: ['Nomi', 'Наименование', 'Name'] },
  'shop.products.col.sku': { d: ['Artikul ustuni', 'Столбец с артикулом', 'Column with the SKU'], m: ['Ixtiyoriy.', 'Необязательно.', 'Optional.'], e: ['Artikul', 'Артикул', 'SKU'] },
  'shop.products.col.barcode': { d: ['Shtrix-kod ustuni', 'Столбец со штрихкодом', 'Column with the barcode'], m: ['Bir nechta kodni vergul bilan ajratish mumkin.', 'Несколько кодов можно разделить запятой.', 'Several codes can be separated by commas.'], e: '4780000000013' },
  'shop.products.col.category': { d: ['Kategoriya ustuni', 'Столбец с категорией', 'Column with the category'], m: ['Ichma-ich kategoriyalarni ">" bilan yozing; yoʻqlari yaratiladi.', 'Вложенные категории пишите через ">"; недостающие создадутся.', 'Write nested categories with ">"; missing ones are created.'], e: ['Ichimliklar > Gazli', 'Напитки > Газированные', 'Drinks > Soft drinks'] },
  'shop.products.col.unit': { d: ['Oʻlchov birligi ustuni', 'Столбец с единицей', 'Column with the unit'], m: ['dona, kg, l, m...', 'шт, кг, л, м...', 'piece, kg, l, m...'], e: 'kg' },
  'shop.products.col.price': { d: ['Narx ustuni (soʻmda)', 'Столбец с ценой (в сумах)', 'Column with the price (major units)'], m: ['Narx tanlangan filiallarga yoziladi.', 'Цена запишется в выбранные филиалы.', 'The price is written to the selected branches.'], e: '12000' },
  'shop.products.col.vatRate': { d: ['QQS ustuni', 'Столбец с НДС', 'Column with VAT %'], m: ['Faqat raqam, % belgisisiz.', 'Только число, без знака %.', 'Number only, without %.'], e: '12' },
  'shop.products.col.mxikCode': { d: ['MXIK kodi ustuni', 'Столбец с ИКПУ', 'Column with the MXIK code'], m: ['17 raqamli kod.', 'Код из 17 цифр.', 'The 17-digit code.'], e: '02202001001000000' },
  'shop.products.col.packageCode': { d: ['Qadoq kodi ustuni', 'Столбец с кодом упаковки', 'Column with the package code'], m: ['Fiskal cheklar uchun.', 'Для фискальных чеков.', 'For fiscal receipts.'], e: '1500' },
  'shop.products.col.isMarked': { d: ['Markirovka ustuni', 'Столбец с маркировкой', 'Column with marking'], m: ['"ha", "1" yoki "true" — markirovkali.', '«да», «1» или «true» — маркированный.', '"yes", "1" or "true" means marked.'], e: '1' },
  'shop.products.col.isWeighted': { d: ['Tortiladigan ustuni', 'Столбец «весовой»', 'Column with weighted'], m: ['"ha", "1" yoki "true" — tarozida sotiladi.', '«да», «1» или «true» — весовой.', '"yes", "1" or "true" means sold by weight.'], e: '1' },

  /* ------------------------------------------------------------------- categories */
  'shop.categories.parent': {
    d: ['Yuqori kategoriya (ixtiyoriy)', 'Родительская категория (необязательно)', 'Parent category (optional)'],
    m: ['Ichma-ich tuzilma hosil qiladi. Yuqori darajadagi kategoriya uchun boʻsh qoldiring.', 'Создаёт вложенную структуру. Для верхнего уровня оставьте пустым.', 'Builds a tree. Leave empty for a top-level category.'],
    e: ['Ichimliklar', 'Напитки', 'Drinks'],
  },
  'shop.categories.sortOrder': {
    d: ['Roʻyxatdagi tartib raqami', 'Порядок в списке', 'Position in the list'],
    m: ['Kichik raqam yuqorida turadi.', 'Меньшее число — выше в списке.', 'Smaller numbers come first.'],
    e: '10',
  },

  /* ------------------------------------------------------------------------- prices */
  'shop.prices.mode': {
    d: ['Narx qanday oʻzgaradi', 'Как менять цену', 'How the price changes'],
    m: ['Foiz yoki aniq summa bilan oshirish/kamaytirish.', 'Повысить или снизить на процент или на сумму.', 'Raise or lower by a percentage or a fixed amount.'],
    e: ['Foiz bilan', 'В процентах', 'By percent'],
  },
  'shop.prices.amount': {
    d: ['Oʻzgarish miqdori', 'Величина изменения', 'Size of the change'],
    m: ['Kamaytirish uchun minus bilan kiriting.', 'Для снижения введите с минусом.', 'Use a minus sign to lower prices.'],
    e: '10',
  },
  'shop.prices.newPrice': {
    d: ['Yangi sotuv narxi', 'Новая цена продажи', 'New selling price'],
    m: ['Tanlangan vaqtdan boshlab kassalarda amal qiladi.', 'Действует на кассах с выбранного времени.', 'Applies at the tills from the chosen time.'],
    e: '13 500',
  },
  'shop.prices.effectiveAt': {
    d: ['Narx qachondan kuchga kiradi', 'Когда цена вступит в силу', 'When the price takes effect'],
    m: ['Boʻsh boʻlsa — darhol. Kelajak sana tanlansa, narx oʻsha vaqtda avtomatik almashadi.', 'Пусто — сразу. Если выбрать будущую дату, цена сменится автоматически.', 'Empty means now. A future time switches the price automatically.'],
    e: '08.11.2026 08:00',
  },
  'shop.prices.from': {
    d: ['Narxlar olinadigan filial', 'Филиал-источник цен', 'Branch to copy prices from'],
    m: ['Shu filialning barcha narxlari nusxalanadi.', 'Будут скопированы все цены этого филиала.', 'All prices of this branch are copied.'],
  },
  'shop.prices.to': {
    d: ['Narxlar yoziladigan filial', 'Филиал, куда копировать', 'Branch to copy prices to'],
    m: ['Bor narxlar "Ustiga yozish" belgilansa almashtiriladi.', 'Существующие цены заменятся, если отмечено «Перезаписать».', 'Existing prices are replaced only if "Overwrite" is ticked.'],
  },
  'shop.prices.overwrite': {
    d: ['Bor narxlarni almashtirish', 'Заменять существующие цены', 'Replace existing prices'],
    m: ['Belgilanmasa, faqat narxi yoʻq mahsulotlarga narx qoʻyiladi.', 'Если не отмечено, цены поставятся только товарам без цены.', 'If off, only products without a price get one.'],
  },
  'shop.prices.missingOnly': {
    d: ['Faqat narxsiz mahsulotlar', 'Только товары без цены', 'Only products without a price'],
    m: ['Narx qoʻyishni unutgan mahsulotlarni tez topish uchun.', 'Чтобы быстро найти товары, которым забыли поставить цену.', 'To quickly find products that were never priced.'],
  },

  /* ---------------------------------------------------------------------- promotions */
  'shop.promos.type': {
    d: ['Aksiya turi', 'Тип акции', 'Kind of promotion'],
    m: ['Foiz, aniq summa, X olsa Y bepul, toʻplam narxi yoki soat boʻyicha chegirma.', 'Процент, фиксированная сумма, X+Y бесплатно, цена комплекта или скидка по часам.', 'Percent, fixed amount, buy X get Y, bundle price or happy hour.'],
    e: ['2+1 (X olsa Y bepul)', '2+1 (купи X — Y бесплатно)', '2+1 (buy X get Y)'],
  },
  'shop.promos.products': {
    d: ['Aksiyadagi mahsulotlar', 'Товары в акции', 'Products in the promotion'],
    m: ['Mahsulotlar yoki kategoriyalardan kamida bittasini tanlang.', 'Выберите хотя бы товары или категории.', 'Pick products or categories (at least one).'],
  },
  'shop.promos.categories': {
    d: ['Aksiyadagi kategoriyalar', 'Категории в акции', 'Categories in the promotion'],
    m: ['Kategoriya va uning ichidagi barcha mahsulotlarga taʼsir qiladi.', 'Действует на категорию и все вложенные товары.', 'Applies to the category and everything inside it.'],
  },
  'shop.promos.amountPerUnit': {
    d: ['Har bir dona uchun chegirma', 'Скидка за единицу', 'Discount per unit'],
    m: ['Har bir sotilgan donadan shu summa ayiriladi.', 'С каждой проданной единицы вычитается эта сумма.', 'This amount is taken off every unit sold.'],
    e: '2 000',
  },
  'shop.promos.buy': {
    d: ['Nechta olish kerak (X)', 'Сколько купить (X)', 'How many to buy (X)'],
    m: ['X dona olinsa, Y dona bepul beriladi.', 'При покупке X штук Y штук бесплатно.', 'Buy X units and get Y units free.'],
    e: '2',
  },
  'shop.promos.get': {
    d: ['Nechtasi bepul (Y)', 'Сколько бесплатно (Y)', 'How many are free (Y)'],
    m: ['Eng arzon donalar bepul hisoblanadi.', 'Бесплатными становятся самые дешёвые единицы.', 'The cheapest units become free.'],
    e: '1',
  },
  'shop.promos.bundleItems': {
    d: ['Toʻplamdagi mahsulotlar', 'Товары комплекта', 'Items in the bundle'],
    m: ['Hammasi chekda boʻlsa, toʻplam narxi qoʻllanadi.', 'Если все есть в чеке, применяется цена комплекта.', 'When all are in the receipt, the bundle price applies.'],
  },
  'shop.promos.bundlePrice': {
    d: ['Butun toʻplam narxi', 'Цена всего комплекта', 'Price of the whole bundle'],
    m: ['Alohida narxlar yigʻindisidan kam boʻlishi kerak.', 'Должна быть меньше суммы отдельных цен.', 'Must be lower than the items’ separate prices.'],
    e: '25 000',
  },
  'shop.promos.startsAt': { d: ['Aksiya boshlanishi', 'Начало акции', 'When the promotion starts'], m: ['Boʻsh — darhol.', 'Пусто — сразу.', 'Empty means now.'], e: '01.12.2026' },
  'shop.promos.endsAt': { d: ['Aksiya tugashi', 'Окончание акции', 'When the promotion ends'], m: ['Boʻsh — muddatsiz.', 'Пусто — бессрочно.', 'Empty means no end date.'], e: '31.12.2026' },
  'shop.promos.days': { d: ['Hafta kunlari', 'Дни недели', 'Days of the week'], m: ['Faqat belgilangan kunlarda ishlaydi.', 'Действует только в отмеченные дни.', 'Runs only on the ticked days.'] },
  'shop.promos.fromTime': { d: ['Har kuni soat nechadan', 'Ежедневно с', 'Daily from'], m: ['"Happy hour" uchun: shu vaqtdan.', 'Для «счастливых часов»: с этого времени.', 'For happy hours: starting at this time.'], e: '18:00' },
  'shop.promos.toTime': { d: ['Har kuni soat nechagacha', 'Ежедневно до', 'Daily until'], m: ['Shu vaqtgacha amal qiladi.', 'Действует до этого времени.', 'Runs until this time.'], e: '21:00' },
  'shop.promos.priority': {
    d: ['Bir nechta aksiya ichida tartib', 'Порядок среди нескольких акций', 'Order among several promotions'],
    m: ['Mahsulotga bir nechta aksiya mos kelsa, raqami katta boʻlgani qoʻllanadi.', 'Если к товару подходят несколько акций, применяется с большим числом.', 'If several promotions fit, the higher number wins.'],
    e: '10',
  },
  'shop.promos.allowStack': {
    d: ['Qoʻlda chegirma bilan qoʻshilishi', 'Совмещать с ручной скидкой', 'Combine with manual discounts'],
    m: ['Belgilanmasa, kassir bu aksiyali mahsulotga qoʻshimcha chegirma bera olmaydi.', 'Если выключено, кассир не сможет дать доп. скидку на акционный товар.', 'If off, the cashier cannot add a discount to this promoted item.'],
  },

  /* ------------------------------------------------------------------------- stock */
  'shop.receipts.supplier': {
    d: ['Tovarni olib kelgan yetkazib beruvchi', 'Поставщик, привёзший товар', 'Supplier who delivered the goods'],
    m: ['Kirim summasi uning qarziga qoʻshiladi.', 'Сумма прихода добавится к долгу поставщику.', 'The receipt total is added to what you owe them.'],
  },
  'shop.receipts.invoiceNo': { d: ['Yetkazib beruvchi hujjati raqami', 'Номер накладной поставщика', 'Supplier invoice number'], m: ['Hujjatni keyin topish uchun.', 'Чтобы потом найти документ.', 'To find the document later.'], e: 'INV-2026-1147' },
  'shop.receipts.invoiceDate': { d: ['Hujjat sanasi', 'Дата накладной', 'Invoice date'], m: ['Yetkazib beruvchi hujjatidagi sana.', 'Дата в документе поставщика.', 'The date on the supplier’s document.'], e: '05.11.2026' },
  'shop.docs.branch': { d: ['Qaysi filial omboriga', 'На склад какого филиала', 'Which branch’s stock'], m: ['Qoldiq shu filialda oʻzgaradi.', 'Остаток изменится в этом филиале.', 'Stock changes in this branch.'] },
  'shop.docs.note': { d: ['Hujjatga izoh', 'Комментарий к документу', 'Note on the document'], m: ['Ichki eslatma, ixtiyoriy.', 'Внутренняя заметка, необязательно.', 'Internal note, optional.'], e: ['Ertalabki yetkazib berish', 'Утренняя поставка', 'Morning delivery'] },
  'shop.docs.reason': { d: ['Hisobdan chiqarish sababi', 'Причина списания', 'Reason for the write-off'], m: ['Hisobotlarda yoʻqotishlar sabab boʻyicha guruhlanadi.', 'В отчётах потери группируются по причине.', 'Losses are grouped by reason in reports.'], e: ['Shikastlangan', 'Повреждён', 'Damaged'] },
  'shop.transfers.from': { d: ['Tovar joʻnatiladigan filial', 'Филиал-отправитель', 'Branch sending the goods'], m: ['Joʻnatilganda shu filial qoldigʻi kamayadi.', 'При отправке остаток здесь уменьшится.', 'Its stock goes down when sent.'] },
  'shop.transfers.to': { d: ['Tovar qabul qiladigan filial', 'Филиал-получатель', 'Branch receiving the goods'], m: ['Qabul qilinganda qoldiq oshadi; farqlar alohida yoziladi.', 'При приёмке остаток вырастет; расхождения фиксируются.', 'Stock goes up on receipt; differences are recorded.'] },
  'shop.counts.category': { d: ['Faqat shu kategoriyani sanash', 'Считать только эту категорию', 'Count only this category'], m: ['Boʻsh — barcha mahsulotlar.', 'Пусто — все товары.', 'Empty means all products.'] },
  'shop.counts.prefill': { d: ['Roʻyxatni avtomatik toʻldirish', 'Заполнить список автоматически', 'Fill the list automatically'], m: ['Barcha faol mahsulotlar sanash uchun qoʻshiladi.', 'Все активные товары добавятся для подсчёта.', 'All active products are added for counting.'] },
  'shop.counts.zeroUncounted': { d: ['Sanalmaganlarni nolga tushirish', 'Обнулить непосчитанные', 'Set uncounted items to zero'], m: ['Belgilanmasa, sanalmagan mahsulotlar qoldigʻi oʻzgarmaydi.', 'Если выключено, остатки непосчитанных не меняются.', 'If off, uncounted items keep their stock.'] },

  /* ---------------------------------------------------------------------- suppliers */
  'shop.suppliers.contact': { d: ['Aloqa uchun shaxs', 'Контактное лицо', 'Contact person'], m: ['Buyurtma va toʻlovlar boʻyicha kim bilan gaplashish kerak.', 'С кем говорить по заказам и оплатам.', 'Who to talk to about orders and payments.'], e: 'Sardor Rahimov' },
  'shop.suppliers.tin': { d: ['Yetkazib beruvchi STIR raqami', 'ИНН поставщика', 'Supplier tax ID'], m: ['9 raqam.', '9 цифр.', '9 digits.'], e: '301234567' },
  'shop.suppliers.address': { d: ['Ombor yoki ofis manzili', 'Адрес склада или офиса', 'Warehouse or office address'], m: ['Ixtiyoriy.', 'Необязательно.', 'Optional.'], e: ['Toshkent, Sergeli 5', 'Ташкент, Сергели 5', 'Tashkent, Sergeli 5'] },
  'shop.suppliers.paymentTerm': { d: ['Toʻlov muddati, kun', 'Срок оплаты, дней', 'Payment term, days'], m: ['Kirimdan keyin necha kunda toʻlash kerak; muddati oʻtgan qarzlar ajratib koʻrsatiladi.', 'Через сколько дней после прихода платить; просроченные долги выделяются.', 'Days to pay after a delivery; overdue debts are highlighted.'], e: '14' },
  'shop.suppliers.method': { d: ['Toʻlov usuli', 'Способ оплаты', 'Payment method'], m: ['Naqd, karta yoki bank oʻtkazmasi.', 'Наличные, карта или перечисление.', 'Cash, card or bank transfer.'] },

  /* ---------------------------------------------------------------------- customers */
  'shop.customers.fullName': { d: ['Mijozning toʻliq ismi', 'ФИО клиента', 'Customer’s full name'], m: ['Kassada qidiruv va chekda koʻrinadi.', 'Ищется на кассе и печатается на чеке.', 'Searchable at the till and printed on the receipt.'], e: 'Dilnoza Yusupova' },
  'shop.customers.card': { d: ['Bonus kartasi shtrix-kodi', 'Штрихкод бонусной карты', 'Loyalty card barcode'], m: ['Kassada kartani skanerlash mijozni darhol tanlaydi.', 'Сканирование карты на кассе сразу выбирает клиента.', 'Scanning the card at the till selects the customer.'], e: '9900000000127' },
  'shop.customers.birthday': { d: ['Tugʻilgan kun', 'День рождения', 'Birthday'], m: ['Tabriklash va maxsus taklif uchun.', 'Для поздравлений и спецпредложений.', 'For greetings and special offers.'], e: '14.03.1990' },
  'shop.customers.creditLimit': { d: ['Qarzga olishning eng katta summasi', 'Максимальная сумма в долг', 'Maximum amount on credit'], m: ['Boʻsh — cheklovsiz. 0 — qarzga sotish taqiqlanadi.', 'Пусто — без ограничения. 0 — в долг нельзя.', 'Empty means no limit. 0 forbids credit.'], e: '1 000 000' },
  'shop.customers.method': { d: ['Qarz qanday toʻlandi', 'Как погашен долг', 'How the debt was paid'], m: ['Naqd toʻlov smena kassasiga qoʻshiladi.', 'Наличная оплата добавляется в кассу смены.', 'Cash payments go into the shift drawer.'] },

  /* --------------------------------------------------------------------- branches */
  'shop.branches.address': { d: ['Filial manzili', 'Адрес филиала', 'Branch address'], m: ['Chekda doʻkon nomi ostida chiqadi.', 'Печатается на чеке под названием.', 'Printed on the receipt under the name.'], e: ['Toshkent, Chilonzor 7-mavze', 'Ташкент, Чиланзар 7-квартал', 'Tashkent, Chilonzor block 7'] },
  'shop.branches.hours': { d: ['Ish vaqti', 'Часы работы', 'Opening hours'], m: ['Maʼlumot uchun; mijozlarga koʻrsatish mumkin.', 'Для справки; можно показывать клиентам.', 'For information; can be shown to customers.'], e: '08:00–23:00' },
  'shop.branches.receiptHeader': { d: ['Chek tepasidagi matn', 'Текст вверху чека', 'Text at the top of the receipt'], m: ['Boʻsh boʻlsa, doʻkon sozlamalaridagi matn ishlatiladi.', 'Если пусто — берётся текст из настроек магазина.', 'If empty, the shop setting is used.'], e: ['Xush kelibsiz!', 'Добро пожаловать!', 'Welcome!'] },
  'shop.branches.receiptFooter': { d: ['Chek pastidagi matn', 'Текст внизу чека', 'Text at the bottom of the receipt'], m: ['Aksiya, telefon yoki Instagram sahifangizni yozing.', 'Напишите акцию, телефон или Instagram.', 'Add an offer, phone or Instagram page.'], e: 'Instagram: @demomarket' },
  'shop.branches.copyPrices': { d: ['Narxlarni boshqa filialdan olish', 'Скопировать цены из филиала', 'Copy prices from a branch'], m: ['Yangi filial ochilganda barcha narxlarni bir marta nusxalaydi.', 'При открытии нового филиала разово копирует все цены.', 'Copies all prices once when the branch is created.'] },

  /* ---------------------------------------------------------------------- terminals */
  'shop.terminals.paper': { d: ['Chek qogʻozi kengligi', 'Ширина чековой ленты', 'Receipt paper width'], m: ['58 mm — 32 belgi, 80 mm — 48 belgi qatorda.', '58 мм — 32 символа, 80 мм — 48 символов в строке.', '58 mm fits 32 characters a line, 80 mm fits 48.'], e: '58 mm' },
  'shop.terminals.codePage': { d: ['Printer harflar jadvali', 'Кодовая таблица принтера', 'Printer character table'], m: ['Xprinter va shunga oʻxshashlar uchun CP866 lotin va kirill harflarini chiqaradi.', 'Для Xprinter и аналогов CP866 печатает латиницу и кириллицу.', 'For Xprinter and similar, CP866 prints Latin and Cyrillic.'], e: 'CP866' },
  'shop.terminals.cut': { d: ['Chekni avtomatik kesish', 'Автоотрез чека', 'Cut the receipt automatically'], m: ['Printerda pichoq boʻlsagina yoqing.', 'Включайте, только если у принтера есть резак.', 'Only if your printer has a cutter.'] },
  'shop.terminals.drawer': { d: ['Pul qutisi printerga ulangan', 'Денежный ящик подключён к принтеру', 'Cash drawer is connected'], m: ['Naqd savdoda quti avtomatik ochiladi.', 'При продаже за наличные ящик откроется сам.', 'The drawer opens by itself on cash sales.'] },

  /* --------------------------------------------------------------------------- staff */
  'shop.staff.fullName': { d: ['Xodimning toʻliq ismi', 'ФИО сотрудника', 'Employee’s full name'], m: ['Chekda kassir sifatida chiqadi.', 'Печатается на чеке как кассир.', 'Printed on receipts as the cashier.'], e: 'Madina Saidova' },
  'shop.staff.role': { d: ['Xodim nima qila oladi', 'Что может сотрудник', 'What the employee can do'], m: ['Kassir — faqat kassa; omborchi — qoldiqlar; menejer — filialni boshqaradi.', 'Кассир — только касса; кладовщик — остатки; менеджер — управляет филиалом.', 'Cashier: till only; storekeeper: stock; manager: runs the branch.'], e: ['Kassir', 'Кассир', 'Cashier'] },
  'shop.staff.login': { d: ['Tizimga kirish nomi', 'Логин для входа', 'Sign-in name'], m: ['Lotin harflari, raqam va nuqta. Butun platformada yagona boʻlishi kerak.', 'Латиница, цифры и точка. Должен быть уникален на всей платформе.', 'Latin letters, digits and dots. Must be unique on the platform.'], e: 'madina.k1' },
  'shop.staff.password': { d: ['Kamida 8 belgili parol', 'Пароль не короче 8 символов', 'Password of at least 8 characters'], m: ['Xodimga shaxsan bering; birinchi kirishdan keyin oʻzgartirishi mumkin.', 'Передайте лично; после первого входа его можно сменить.', 'Hand it over in person; they can change it after signing in.'], e: 'Kassa2026!' },
  'shop.staff.pin': { d: ['Kassada tez kirish uchun PIN', 'PIN для быстрого входа на кассе', 'PIN for quick sign-in at the till'], m: ['4–6 raqam. Menejer PIN i chegirma va qaytarishni tasdiqlash uchun ham ishlatiladi.', '4–6 цифр. PIN менеджера также подтверждает скидки и возвраты.', '4–6 digits. A manager’s PIN also approves discounts and returns.'], e: '4821' },
  'shop.staff.branches': { d: ['Xodim ishlaydigan filiallar', 'Филиалы сотрудника', 'Branches the employee works in'], m: ['Faqat shu filiallar maʼlumotini koʻradi va ularning kassalarida ishlaydi.', 'Видит данные и работает на кассах только этих филиалов.', 'They only see and work at these branches.'] },
  'shop.staff.extraPermissions': { d: ['Roldan tashqari ruxsatlar', 'Права сверх роли', 'Permissions beyond the role'], m: ['Masalan, kassirga qarzga sotishga ruxsat berish.', 'Например, разрешить кассиру продавать в долг.', 'For example, let a cashier sell on credit.'] },

  /* ------------------------------------------------------------------- shop settings */
  'settings:common.currency': { d: ['Doʻkon valyutasi', 'Валюта магазина', 'Shop currency'], m: ['Birinchi savdodan keyin oʻzgartirib boʻlmaydi.', 'После первой продажи изменить нельзя.', 'Locked after the first sale.'], e: 'UZS' },
  'shop.settings.address': { d: ['Doʻkonning yuridik manzili', 'Юридический адрес магазина', 'Shop’s legal address'], m: ['Hisob-fakturalar va hisobotlar uchun.', 'Для счетов и отчётов.', 'For invoices and reports.'], e: ['Toshkent, Amir Temur 15', 'Ташкент, Амир Темур 15', 'Tashkent, Amir Temur 15'] },
  'shop.settings.tin': { d: ['Doʻkon STIR raqami', 'ИНН магазина', 'Shop tax ID'], m: ['9 raqam; chekda chiqadi va fiskal cheklar uchun majburiy.', '9 цифр; печатается на чеке и обязателен для фискальных чеков.', '9 digits; printed on receipts and required for fiscal receipts.'], e: '305987654' },
  'shop.settings.receiptLanguage': { d: ['Chek qaysi tilda chiqadi', 'На каком языке печатать чек', 'Language of printed receipts'], m: ['Kassir interfeysi tilidan qatʼi nazar.', 'Независимо от языка интерфейса кассира.', 'Independent of the cashier’s interface language.'], e: ['Oʻzbekcha', 'Русский', 'Uzbek'] },
  'shop.settings.header': { d: ['Barcha cheklar tepasidagi matn', 'Текст вверху всех чеков', 'Text at the top of every receipt'], m: ['Filial oʻz matnini kiritsa, oʻsha ishlatiladi.', 'Если у филиала свой текст — используется он.', 'A branch’s own text takes priority.'], e: ['Xush kelibsiz!', 'Добро пожаловать!', 'Welcome!'] },
  'shop.settings.footer': { d: ['Barcha cheklar pastidagi matn', 'Текст внизу всех чеков', 'Text at the bottom of every receipt'], m: ['Rahmat soʻzi, telefon yoki ijtimoiy tarmoq.', 'Благодарность, телефон или соцсети.', 'A thank-you, phone or social media.'], e: ['Yana kutib qolamiz!', 'Ждём вас снова!', 'Come again!'] },
  'shop.settings.logo': { d: ['Chek uchun logotip', 'Логотип для чеков', 'Logo for receipts'], m: ['Oq-qora, kontrastli PNG eng yaxshi chiqadi.', 'Лучше всего печатается контрастный чёрно-белый PNG.', 'A high-contrast black-and-white PNG prints best.'] },
  'shop.settings.maxDiscount': { d: ['Kassir menejersiz bera oladigan chegirma', 'Скидка кассира без менеджера', 'Discount a cashier may give alone'], m: ['Undan katta chegirma uchun menejer PIN kodi soʻraladi.', 'Для большей скидки потребуется PIN менеджера.', 'Anything above needs a manager’s PIN.'], e: '5' },
  'shop.settings.bonusPercent': { d: ['Xariddan qaytadigan bonus, %', 'Бонус с покупки, %', 'Bonus earned per purchase, %'], m: ['Mijoz kartasiga chek summasidan shu foiz yoziladi.', 'На карту клиента начисляется этот процент от чека.', 'This share of the receipt goes to the customer’s card.'], e: '2' },
  'shop.settings.maxPayPercent': { d: ['Chekning bonus bilan toʻlanadigan qismi', 'Часть чека, оплачиваемая бонусами', 'Share of a receipt payable by bonus'], m: ['Masalan 50% — chekning yarmigacha bonus bilan toʻlash mumkin.', 'Например 50% — бонусами можно оплатить до половины чека.', 'E.g. 50% lets bonuses pay up to half a receipt.'], e: '50' },
  'shop.settings.shiftAlert': { d: ['Uzoq ochiq smena haqida xabar', 'Оповещение о долгой смене', 'Alert for long-open shifts'], m: ['Smena shuncha soatdan koʻp ochiq qolsa, Telegram orqali xabar keladi.', 'Если смена открыта дольше, придёт сообщение в Telegram.', 'You get a Telegram message when a shift stays open longer.'], e: '14' },
  'shop.settings.negativeStock': { d: ['Qoldiqsiz sotishga ruxsat', 'Продажа при нулевом остатке', 'Allow selling without stock'], m: ['Yoqilsa, kassa sotadi va qoldiq minusga tushadi; hisobotda ogohlantirish chiqadi.', 'Если включено, касса продаст и остаток уйдёт в минус; будет предупреждение.', 'If on, the till sells and stock goes negative, with a warning in reports.'] },

  /* ---------------------------------------------------------------------- developers */
  'shop.dev.scopes': { d: ['Kalitga ruxsat etilgan amallar', 'Что разрешено ключу', 'What the key may do'], m: ['Faqat kerakli ruxsatlarni bering: masalan, buxgalteriyaga "savdolarni oʻqish" yetarli.', 'Давайте только нужное: например, бухгалтерии хватит «чтения продаж».', 'Grant only what is needed: accounting usually needs "sales:read" only.'], e: 'products:read, sales:read' },
  'shop.dev.expires': { d: ['Kalit amal qilish muddati', 'Срок действия ключа', 'Key expiry date'], m: ['Boʻsh — muddatsiz. Vaqtinchalik integratsiyalar uchun sana qoʻying.', 'Пусто — бессрочно. Для временных интеграций укажите дату.', 'Empty means no expiry. Set a date for temporary integrations.'], e: '31.12.2026' },
  'shop.dev.events': { d: ['Qaysi hodisalar yuboriladi', 'Какие события отправлять', 'Which events are sent'], m: ['Tanlangan hodisa yuz berganda manzilingizga imzolangan POST soʻrov yuboriladi.', 'При событии на ваш адрес уходит подписанный POST-запрос.', 'Each chosen event sends a signed POST to your URL.'], e: 'sale.created' },

  /* ------------------------------------------------------------------------ reports */
  'shop.reports.report': { d: ['Qaysi hisobot', 'Какой отчёт', 'Which report'], m: ['Har bir hisobotni Excel yoki PDF koʻrinishida yuklab olish mumkin.', 'Каждый отчёт можно скачать в Excel или PDF.', 'Every report can be downloaded as Excel or PDF.'] },
  'shop.reports.filter.days': { d: ['Necha kundan beri sotilmagan', 'Сколько дней без продаж', 'Days without sales'], m: ['Shuncha kun sotilmagan "oʻlik" mahsulotlarni topadi.', 'Находит «залежавшиеся» товары без продаж за этот срок.', 'Finds slow-moving products not sold for this long.'], e: '30' },
  'shop.reports.filter.groupBy': { d: ['Guruhlash usuli', 'Группировка', 'Group by'], m: ['Kun, hafta yoki oy boʻyicha jamlash.', 'Итоги по дням, неделям или месяцам.', 'Totals by day, week or month.'] },
  'shop.reports.filter.date': { d: ['Qoldiq qaysi sanaga', 'Остаток на дату', 'Stock as of this date'], m: ['Oʻtgan sana uchun qoldiq harakatlar tarixidan hisoblanadi.', 'Для прошлой даты остаток считается по истории движений.', 'For a past date, stock is rebuilt from the movement history.'], e: '01.11.2026' },
  'shop.reports.filter.missingOnly': { d: ['Faqat narxsiz mahsulotlar', 'Только без цены', 'Only products without a price'], m: ['Narx qoʻyilmagan mahsulotlar roʻyxati.', 'Список товаров без цены.', 'Lists products that have no price.'] },

  /* ----------------------------------------------------------------- superadmin: shops */
  'sa.shop.name': { d: ['Doʻkonning rasmiy nomi', 'Официальное название магазина', 'The shop’s official name'], m: ['Doʻkon egasi keyin sozlamalarda oʻzgartira oladi.', 'Владелец сможет изменить его в настройках.', 'The owner can change it later in Settings.'], e: 'Demo Market' },
  'sa.shop.address': { d: ['Asosiy manzil', 'Основной адрес', 'Main address'], m: ['Birinchi filial manzili sifatida ham ishlatiladi.', 'Используется и как адрес первого филиала.', 'Also used as the first branch’s address.'], e: ['Toshkent, Chilonzor 7', 'Ташкент, Чиланзар 7', 'Tashkent, Chilonzor 7'] },
  'sa.shop.tin': { d: ['Doʻkon STIR raqami (9 raqam)', 'ИНН магазина (9 цифр)', 'Shop tax ID (9 digits)'], m: ['Fiskal cheklar yoqilsa majburiy.', 'Обязателен, если включены фискальные чеки.', 'Required when fiscal receipts are on.'], e: '305987654' },
  'sa.shop.firstBranch': { d: ['Birinchi filial nomi', 'Название первого филиала', 'Name of the first branch'], m: ['Doʻkon shu filial bilan yaratiladi; qolganlarini egasi qoʻshadi.', 'Магазин создаётся с этим филиалом; остальные добавит владелец.', 'The shop starts with this branch; the owner adds more.'], e: ['Asosiy', 'Основной', 'Main'] },
  'sa.shop.paidUntil': { d: ['Obuna tugash sanasi', 'Оплачено до', 'Subscription paid until'], m: ['Boʻsh — sinov muddati. Sanadan keyin imtiyozli davr boshlanadi, soʻng kirish toʻxtaydi.', 'Пусто — пробный период. После даты идёт льготный период, затем доступ закрывается.', 'Empty means trial. After this date a grace period starts, then access stops.'], e: '31.12.2026' },
  'sa.shop.adminName': { d: ['Doʻkon egasining ismi', 'Имя владельца магазина', 'Shop owner’s full name'], m: ['Panelda va xabarlarda koʻrinadi.', 'Видно в панели и сообщениях.', 'Shown in the panel and messages.'], e: 'Mirzayev Qosimboy' },
  'sa.shop.adminLogin': { d: ['Egasining kirish nomi', 'Логин владельца', 'Owner’s sign-in name'], m: ['Butun platformada yagona boʻlishi kerak.', 'Должен быть уникален на всей платформе.', 'Must be unique on the whole platform.'], e: 'arzonchi.admin' },
  'sa.shop.adminPassword': { d: ['Egasining dastlabki paroli', 'Начальный пароль владельца', 'Owner’s first password'], m: ['Kamida 8 belgi; egasiga xavfsiz yoʻl bilan bering.', 'Не меньше 8 символов; передайте безопасно.', 'At least 8 characters; hand it over safely.'], e: 'Start2026!' },
  'sa.shop.fiscalReceipts': { d: ['Cheklarni soliq tizimiga yuborish', 'Отправлять чеки в налоговую', 'Send receipts to the tax system'], m: ['Yoqilsa, har bir savdo fiskal modul orqali roʻyxatga olinadi; STIR va kassalarda modul sozlanishi kerak.', 'Если включено, каждая продажа регистрируется через фискальный модуль; нужен ИНН и модуль на кассах.', 'If on, every sale is registered through a fiscal module; needs a tax ID and a module per till.'] },
  'sa.shop.maxBranches': { d: ['Ruxsat etilgan filiallar soni', 'Допустимое число филиалов', 'Branches allowed'], m: ['Tarif boʻyicha cheklov.', 'Ограничение тарифа.', 'A plan limit.'], e: '3' },
  'sa.shop.maxTerminals': { d: ['Ruxsat etilgan kassalar soni', 'Допустимое число касс', 'Tills allowed'], m: ['Tarif boʻyicha cheklov.', 'Ограничение тарифа.', 'A plan limit.'], e: '5' },
  'sa.shop.maxEmployees': { d: ['Ruxsat etilgan xodimlar soni', 'Допустимое число сотрудников', 'Employees allowed'], m: ['Egasidan tashqari.', 'Не считая владельца.', 'Not counting the owner.'], e: '15' },
  'sa.shop.method': { d: ['Toʻlov usuli', 'Способ оплаты', 'Payment method'], m: ['Hisobotda platforma daromadi usul boʻyicha koʻrinadi.', 'В отчёте доход платформы виден по способам.', 'Platform income is shown by method.'], e: ['Bank oʻtkazmasi', 'Перечисление', 'Bank transfer'] },
  'sa.shop.periodFrom': { d: ['Toʻlov qoplaydigan davr boshi', 'Начало оплаченного периода', 'Start of the paid period'], m: ['Odatda oldingi muddat tugagan kun.', 'Обычно день окончания прошлого периода.', 'Usually the day the previous period ended.'], e: '01.12.2026' },
  'sa.shop.periodTo': { d: ['Toʻlov qoplaydigan davr oxiri', 'Конец оплаченного периода', 'End of the paid period'], m: ['Bu sana doʻkonning yangi "toʻlangan muddati" boʻladi.', 'Эта дата станет новым «оплачено до».', 'This becomes the shop’s new "paid until".'], e: '31.12.2026' },
  'sa.shop.provider': { d: ['Fiskal modul provayderi', 'Провайдер фискального модуля', 'Fiscal module provider'], m: ['Sinov uchun "mock" — haqiqiy soliq tizimiga yubormaydi.', 'Для проверки — «mock», в налоговую не отправляет.', '"mock" is for testing and sends nothing to the tax system.'], e: 'mock' },
  'sa.shop.moduleId': { d: ['Fiskal modul yoki terminal ID', 'ID фискального модуля', 'Fiscal module / terminal ID'], m: ['Provayder bergan seriya raqami.', 'Серийный номер от провайдера.', 'The serial number from the provider.'], e: 'UZ210317005432' },
  'sa.shop.credentials': { d: ['Provayderga ulanish maʼlumotlari', 'Данные подключения к провайдеру', 'Provider connection details'], m: ['JSON koʻrinishida; shifrlangan saqlanadi va qayta koʻrsatilmaydi.', 'В формате JSON; хранится зашифрованным и больше не показывается.', 'JSON; stored encrypted and never shown again.'], e: '{"token":"…","url":"https://…"}' },

  /* --------------------------------------------------------------- superadmin: settings */
  'sa.settings.platformName': { d: ['Platformaning koʻrinadigan nomi', 'Название платформы', 'Name of the platform'], m: ['Kirish sahifasida va xatlarda chiqadi.', 'Видно на странице входа и в письмах.', 'Shown on the sign-in page and in messages.'], e: 'Online Kass' },
  'sa.settings.graceDays': { d: ['Toʻlov muddatidan keyingi imtiyoz kunlari', 'Льготные дни после окончания оплаты', 'Grace days after the paid period'], m: ['Shu kunlar davomida doʻkon ishlaydi, lekin ogohlantirish koʻradi.', 'В эти дни магазин работает, но видит предупреждение.', 'The shop keeps working but sees a warning.'], e: '3' },
  'sa.settings.longShiftHours': { d: ['Uzoq smena chegarasi, soat', 'Порог долгой смены, часов', 'Long-shift threshold, hours'], m: ['Undan uzun ochiq smenalar haqida ogohlantiriladi.', 'О сменах длиннее будет оповещение.', 'Shifts open longer trigger an alert.'], e: '16' },
  'sa.settings.agentVersion': { d: ['Agentning joriy versiyasi', 'Текущая версия агента', 'Current agent version'], m: ['Eski versiyali kassalarda yangilash taklifi chiqadi.', 'Кассам со старой версией предложат обновиться.', 'Tills on older versions are offered an update.'], e: '1.2.0' },
  'sa.settings.agentUrl': { d: ['Agent oʻrnatuvchisi havolasi', 'Ссылка на установщик агента', 'Agent installer link'], m: ['Doʻkonlar shu havoladan yuklab oladi.', 'Магазины скачивают агент по этой ссылке.', 'Shops download the agent from this link.'], e: 'https://…/OnlineKassAgent-1.2.0.exe' },

  /* ------------------------------------------------------------ superadmin: programs */
  'sa.prog.terminal': { d: ['Dastur ishlaydigan kassa', 'Касса, где работает программа', 'Till the program runs at'], m: ['Savdolar va smenalar shu kassaga yoziladi.', 'Продажи и смены записываются на эту кассу.', 'Sales and shifts are recorded on this till.'], e: ['Kassa 1 · Chilonzor', 'Касса 1 · Чиланзар', 'Till 1 · Chilonzor'] },
  'sa.prog.cashier': { d: ['Smenalar kimning nomidan ochiladi', 'На чьё имя открываются смены', 'Whose name the shifts open under'], m: ['Chekda kassir sifatida shu xodim chiqadi.', 'На чеке кассиром будет этот сотрудник.', 'This person is printed as the cashier.'], e: 'Demo Cashier' },
  'sa.prog.apiUrl': { d: ['Kassa kompyuteri ulanadigan manzil', 'Адрес сервера для компьютера кассы', 'Address the till computer connects to'], m: ['Odatda sayt manzili + /api/v1. Kassa kompyuteridan ochilishi kerak.', 'Обычно адрес сайта + /api/v1. Должен открываться с компьютера кассы.', 'Usually the site address plus /api/v1. Must be reachable from the till.'], e: 'https://kassa.example.uz/api/v1' },
  'sa.prog.language': { d: ['Dastur oynasi tili', 'Язык окна программы', 'Language of the program window'], m: ['Keyin dastur sozlamalarida oʻzgartirish mumkin.', 'Можно сменить позже в настройках программы.', 'Can be changed later in the program settings.'] },
  'sa.prog.scannerPort': { d: ['Skaner ulangan COM port', 'COM-порт сканера', 'COM port of the scanner'], m: ['auto — birinchi USB COM port; none — skaner klaviatura rejimida. Portni Windows "Qurilmalar dispetcheri"da koʻrish mumkin.', 'auto — первый USB COM-порт; none — сканер в режиме клавиатуры. Порт видно в «Диспетчере устройств».', 'auto picks the first USB COM port; none means keyboard mode. See the port in Device Manager.'], e: 'COM3' },
  'sa.prog.baud': { d: ['Port tezligi', 'Скорость порта', 'Port speed'], m: ['Koʻpchilik skanerlar 9600 da ishlaydi.', 'Большинство сканеров работают на 9600.', 'Most scanners use 9600.'], e: '9600' },
  'sa.prog.printerType': { d: ['Chek printeri qanday ulangan', 'Как подключён принтер чеков', 'How the receipt printer is connected'], m: ['USB printer Windows da oʻrnatilgan boʻlsa — "Windows printeri".', 'Если USB-принтер установлен в Windows — «Принтер Windows».', 'A USB printer installed in Windows: choose "Windows printer".'] },
  'sa.prog.printerName': { d: ['Windows dagi printer nomi', 'Имя принтера в Windows', 'Printer name in Windows'], m: ['"Printerlar va skanerlar" roʻyxatidagi nom. Boʻsh — asosiy printer.', 'Как в списке «Принтеры и сканеры». Пусто — принтер по умолчанию.', 'As listed in "Printers & scanners". Empty uses the default.'], e: 'XP-58' },
  'sa.prog.printerPort': { d: ['Printer ulangan COM port', 'COM-порт принтера', 'COM port of the printer'], m: ['Skaner porti bilan bir xil boʻlmasin.', 'Не должен совпадать с портом сканера.', 'Must differ from the scanner’s port.'], e: 'COM4' },
  'sa.prog.host': { d: ['Tarmoq printerining IP manzili', 'IP-адрес сетевого принтера', 'Network printer IP address'], m: ['Printer sinov sahifasida yozilgan boʻladi.', 'Указан на тестовой странице принтера.', 'Printed on the printer’s self-test page.'], e: '192.168.1.50' },
  'sa.prog.tcpPort': { d: ['Printer porti', 'Порт принтера', 'Printer port'], m: ['ESC/POS printerlarda odatda 9100.', 'У ESC/POS-принтеров обычно 9100.', 'Usually 9100 for ESC/POS printers.'], e: '9100' },
  'sa.prog.paper': { d: ['Chek qogʻozi kengligi', 'Ширина чековой ленты', 'Receipt paper width'], m: ['58 mm — 32 belgi, 80 mm — 48 belgi.', '58 мм — 32 символа, 80 мм — 48.', '58 mm: 32 characters, 80 mm: 48.'], e: '58 mm' },
  'sa.prog.codePage': { d: ['Printer harflar jadvali', 'Кодовая таблица принтера', 'Printer character table'], m: ['CP866 Xprinter da lotin va kirillni chiqaradi.', 'CP866 печатает латиницу и кириллицу на Xprinter.', 'CP866 prints Latin and Cyrillic on Xprinter.'], e: 'CP866' },
};

export const LANG_INDEX: Record<string, 0 | 1 | 2> = { uz: 0, ru: 1, en: 2 };
