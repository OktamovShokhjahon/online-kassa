'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState, type ReactNode } from 'react';
import { apiPage, patch, post, qs } from '@/lib/api';
import { Button, Checkbox, DataTable, Field, FormError, Input, Modal, MoneyInput, PageHeader, Pagination, Select, Textarea, useToast, type Column } from './ui';

export interface FieldDef {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'money' | 'select' | 'checkbox' | 'textarea' | 'password' | 'tel' | 'date' | 'multiselect';
  options?: Array<{ value: string; label: string }> | ((form: Record<string, any>) => Array<{ value: string; label: string }>);
  required?: boolean;
  hint?: string;
  createOnly?: boolean;
  editOnly?: boolean;
  show?: (form: Record<string, any>) => boolean;
  span?: 2;
  autoComplete?: string;
}

export function FormFields({ fields, form, set, creating }: { fields: FieldDef[]; form: Record<string, any>; set: (k: string, v: unknown) => void; creating: boolean }) {
  // A required <select> has no empty option, so the browser shows its first option while the
  // form value is still empty. Store that first option so what is shown is what gets sent.
  const unset = fields
    .filter((f) => f.type === 'select' && f.required && !(creating ? f.editOnly : f.createOnly) && (!f.show || f.show(form)))
    .map((f) => [f.key, (typeof f.options === 'function' ? f.options(form) : f.options)?.[0]?.value] as const)
    .filter(([k, first]) => first !== undefined && (form[k] === '' || form[k] === null || form[k] === undefined));
  const unsetKey = JSON.stringify(unset);
  useEffect(() => {
    for (const [k, first] of unset) set(k, first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unsetKey]);
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {fields
        .filter((f) => !(creating ? f.editOnly : f.createOnly) && (!f.show || f.show(form)))
        .map((f) => {
          const v = form[f.key];
          const opts = typeof f.options === 'function' ? f.options(form) : f.options;
          const common = { id: f.key, required: f.required, autoComplete: f.autoComplete };
          let control: ReactNode;
          switch (f.type) {
            case 'checkbox': control = <Checkbox checked={!!v} onChange={(e) => set(f.key, e.target.checked)} label={f.label} />; break;
            case 'textarea': control = <Textarea value={v ?? ''} onChange={(e) => set(f.key, e.target.value)} />; break;
            case 'money': control = <MoneyInput value={v} onChange={(n) => set(f.key, n)} />; break;
            case 'number': control = <Input type="number" value={v ?? ''} onChange={(e) => set(f.key, e.target.value === '' ? '' : Number(e.target.value))} {...common} />; break;
            case 'date': control = <Input type="date" value={v ?? ''} onChange={(e) => set(f.key, e.target.value)} {...common} />; break;
            case 'password': control = <Input type="password" value={v ?? ''} onChange={(e) => set(f.key, e.target.value)} autoComplete="new-password" required={f.required} />; break;
            case 'tel': control = <Input type="tel" value={v ?? ''} onChange={(e) => set(f.key, e.target.value)} {...common} />; break;
            case 'select':
              control = (
                <Select value={v ?? ''} onChange={(e) => set(f.key, e.target.value)} required={f.required}>
                  {!f.required && <option value="" />}
                  {opts?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              );
              break;
            case 'multiselect':
              control = (
                <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-lg border border-border p-2">
                  {opts?.map((o) => (
                    <Checkbox key={o.value} label={o.label} checked={(v ?? []).includes(o.value)} onChange={(e) => set(f.key, e.target.checked ? [...(v ?? []), o.value] : (v ?? []).filter((x: string) => x !== o.value))} />
                  ))}
                </div>
              );
              break;
            default: control = <Input value={v ?? ''} onChange={(e) => set(f.key, e.target.value)} {...common} />;
          }
          if (f.type === 'checkbox') return <div key={f.key} className={f.span === 2 ? 'md:col-span-2' : ''}>{control}</div>;
          return <Field key={f.key} label={f.label} hint={f.hint} className={f.span === 2 || f.type === 'multiselect' ? 'md:col-span-2' : ''}>{control}</Field>;
        })}
    </div>
  );
}

/**
 * Generic list + create/edit modal for simple resources (branches, suppliers, customers, staff...).
 * The server validates everything again; its error messages are shown translated.
 */
export function CrudPage<T extends { id: string }>({
  title, endpoint, queryKey, columns, fields, canWrite = true, searchable = true, extraParams, toBody, fromRow, rowActions, headerActions, createLabel, emptyForm, canEditRow, onRowClick, children,
}: {
  title: ReactNode;
  endpoint: string;
  queryKey: string;
  columns: Column<T>[];
  fields: FieldDef[];
  canWrite?: boolean;
  searchable?: boolean;
  extraParams?: Record<string, string | number | undefined>;
  toBody?: (form: Record<string, any>, creating: boolean) => Record<string, unknown>;
  fromRow?: (row: T) => Record<string, any>;
  rowActions?: (row: T, reload: () => void) => ReactNode;
  headerActions?: ReactNode;
  createLabel?: string;
  emptyForm?: Record<string, any>;
  canEditRow?: (row: T) => boolean;
  onRowClick?: (row: T) => void;
  children?: ReactNode;
}) {
  const tc = useTranslations('common');
  const toast = useToast();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<{ row?: T; form: Record<string, any> } | null>(null);

  const { data, isLoading } = useQuery({ queryKey: [queryKey, page, q, extraParams], queryFn: () => apiPage<T>(endpoint + qs({ page, limit: 20, q, ...extraParams })) });
  const reload = () => qc.invalidateQueries({ queryKey: [queryKey] });
  const save = useMutation({
    mutationFn: (form: Record<string, any>) => {
      const creating = !editing?.row;
      const body = toBody ? toBody(form, creating) : form;
      return creating ? post(endpoint, body) : patch(`${endpoint}/${editing!.row!.id}`, body);
    },
    onSuccess: () => { reload(); setEditing(null); toast.ok(tc('saved')); },
  });

  const cols: Column<T>[] = [
    ...columns,
    ...((canWrite || rowActions) ? [{ key: '__a', header: tc('actions'), render: (r: T) => (
      <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
        {canWrite && (canEditRow?.(r) ?? true) && <Button size="sm" variant="secondary" onClick={() => { save.reset(); setEditing({ row: r, form: fromRow ? fromRow(r) : { ...r } }); }}>{tc('edit')}</Button>}
        {rowActions?.(r, reload)}
      </div>
    ) } as Column<T>] : []),
  ];

  return (
    <>
      <PageHeader
        title={title}
        actions={<>{headerActions}{canWrite && <Button onClick={() => { save.reset(); setEditing({ form: { ...(emptyForm ?? {}) } }); }}>{createLabel ?? tc('create')}</Button>}</>}
      />
      {searchable && <Input className="mb-3 w-72" placeholder={tc('search')} value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />}
      {children}
      <DataTable loading={isLoading} rows={data?.data} columns={cols} onRowClick={onRowClick} />
      {data?.meta && <Pagination page={data.meta.page} limit={data.meta.limit} total={data.meta.total} onPage={setPage} />}
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.row ? tc('edit') : createLabel ?? tc('create')}
        footer={<><Button variant="secondary" onClick={() => setEditing(null)}>{tc('cancel')}</Button><Button loading={save.isPending} onClick={() => editing && save.mutate(editing.form)}>{tc('save')}</Button></>}
      >
        {editing && (
          <form onSubmit={(e) => { e.preventDefault(); save.mutate(editing.form); }} className="space-y-3">
            <FormFields fields={fields} form={editing.form} creating={!editing.row} set={(k, v) => setEditing((s) => (s ? { ...s, form: { ...s.form, [k]: v } } : s))} />
            <FormError error={save.error} />
            <button type="submit" className="hidden" />
          </form>
        )}
      </Modal>
    </>
  );
}
