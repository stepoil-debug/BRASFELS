-- Aceita o novo modelo “Tabela de Spools e Valores” no histórico de importação.
alter table brasfels.import_batches
  drop constraint if exists import_batches_source_type_check;

alter table brasfels.import_batches
  add constraint import_batches_source_type_check
  check (
    source_type = any (
      array[
        'spool_map'::text,
        'spool_materials'::text,
        'p83_production'::text,
        'p83_billing'::text,
        'p85_scope_values'::text,
        'legacy_reference'::text,
        'billing_reference'::text,
        'joints'::text,
        'drawings'::text,
        'measurement'::text,
        'invoices'::text,
        'supports'::text
      ]
    )
  );
