-- ═════════════════════════════════════════════════════════════════════════════
-- DEPOTEK — Facturation intelligente
--   sale_quote()  : aperçu en direct d'une facture à plusieurs lignes (stock dispo,
--                   coût FEFO estimé, marge, prix sous le coût, crédit du client).
--   create_sale() : une facture, plusieurs produits, sortie FEFO par ligne,
--                   mêmes règles de blocage que dispatch_fefo.
--   set_setting() : informations de l'entreprise imprimées sur les factures.
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.sale_quote(p_client text, p_lines jsonb, p_depot text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_client  clients;
  v_depot   uuid;
  v_lines   jsonb := '[]'::jsonb;
  v_total   bigint := 0;
  v_cost    bigint := 0;
  v_balance bigint := 0;
  v_overdue bigint := 0;
  v_ok      boolean := true;
  l         jsonb;
  v_prod    products;
  v_qty     numeric;
  v_price   bigint;
  v_avail   numeric;
  v_left    numeric;
  v_lcost   numeric;
  v_min_cost numeric;
  w         text[];
  r         record;
begin
  perform require_role('magasinier', 'manager', 'cfo');
  if nullif(trim(p_client), '') is not null then
    v_client := resolve_client(p_client);
    select coalesce(sum(balance_xof), 0), coalesce(sum(balance_xof) filter (where days_overdue > 0), 0)
      into v_balance, v_overdue from v_receivables where client_id = v_client.id;
  end if;
  if p_depot is not null then v_depot := (resolve_depot(p_depot)).id; end if;

  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    w := '{}';
    begin v_prod := resolve_product(l->>'product'); exception when others then continue; end;
    v_qty   := coalesce((l->>'qty')::numeric, 0);
    v_price := coalesce(nullif(l->>'price', '')::bigint, v_prod.default_price_xof);
    select coalesce(sum(b.quantity), 0) into v_avail
      from stock_balances b join lots lo on lo.id = b.lot_id
     where lo.product_id = v_prod.id and lo.owner_client_id is null and b.quantity > 0
       and (v_depot is null or b.depot_id = v_depot) and (lo.expiry_date is null or lo.expiry_date >= current_date);
    -- coût FEFO estimé des lots qui sortiraient
    v_left := v_qty; v_lcost := 0; v_min_cost := null;
    for r in
      select b.quantity, lo.cost_unit_xof as c
        from stock_balances b join lots lo on lo.id = b.lot_id
       where lo.product_id = v_prod.id and lo.owner_client_id is null and b.quantity > 0
         and (v_depot is null or b.depot_id = v_depot) and (lo.expiry_date is null or lo.expiry_date >= current_date)
       order by lo.expiry_date nulls last, lo.created_at
    loop
      exit when v_left <= 0;
      v_lcost := v_lcost + least(r.quantity, v_left) * coalesce(r.c, 0);
      if r.c is not null and r.c > 0 then v_min_cost := greatest(coalesce(v_min_cost, 0), r.c); end if;
      v_left := v_left - least(r.quantity, v_left);
    end loop;
    if v_qty <= 0 then w := w || 'Quantité à saisir'; v_ok := false; end if;
    if v_price is null then w := w || 'Prix à saisir'; v_ok := false; end if;
    if v_qty > v_avail then w := w || ('Stock insuffisant : ' || trim(to_char(v_avail, 'FM999G999G990')) || ' disponible(s)'); v_ok := false; end if;
    if v_price is not null and v_min_cost is not null and v_price < v_min_cost then
      w := w || ('Sous le prix de revient (' || round(v_min_cost) || ' FCFA)'); v_ok := false;
    end if;
    v_total := v_total + coalesce(round(v_qty * v_price), 0);
    v_cost  := v_cost + round(v_lcost);
    v_lines := v_lines || jsonb_build_object(
      'product', v_prod.name, 'sku', v_prod.sku, 'unit', v_prod.unit_type, 'qty', v_qty, 'price', v_price,
      'default_price', v_prod.default_price_xof, 'available', v_avail, 'line_total', coalesce(round(v_qty * v_price), 0),
      'cost', round(v_lcost), 'margin', coalesce(round(v_qty * v_price), 0) - round(v_lcost),
      'unit_cost', case when v_qty > 0 then round(v_lcost / v_qty) end, 'warnings', to_jsonb(w));
  end loop;

  return jsonb_build_object(
    'client', v_client.name, 'credit_limit', v_client.credit_limit_xof, 'terms_days', v_client.payment_terms_days,
    'balance', v_balance, 'overdue', v_overdue, 'total', v_total, 'cost', v_cost, 'margin', v_total - v_cost,
    'margin_pct', case when v_total > 0 then round(100.0 * (v_total - v_cost) / v_total, 1) end,
    'over_limit', coalesce(v_client.credit_limit_xof, 0) > 0 and v_balance + v_total > v_client.credit_limit_xof,
    'ok', v_ok and not (coalesce(v_client.credit_limit_xof, 0) > 0 and v_balance + v_total > v_client.credit_limit_xof),
    'due_date', current_date + coalesce(v_client.payment_terms_days, 0),
    'lines', v_lines);
end $$;

create or replace function public.create_sale(
  p_client text, p_lines jsonb, p_depot text default null, p_due_days integer default null,
  p_force boolean default false, p_notes text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_client  clients;
  v_depot   uuid;
  v_invoice uuid;
  v_number  text;
  v_total   bigint := 0;
  v_balance bigint;
  v_forced  boolean := false;
  l         jsonb;
  v_prod    products;
  v_qty     numeric;
  v_price   bigint;
  v_left    numeric;
  v_take    numeric;
  v_avail   numeric;
  v_picks   jsonb := '[]'::jsonb;
  r         record;
begin
  perform require_role('magasinier', 'manager');
  if p_lines is null or jsonb_array_length(p_lines) = 0 then raise exception 'Ajoutez au moins un produit'; end if;
  v_client := resolve_client(p_client);
  if p_depot is not null then v_depot := (resolve_depot(p_depot)).id; end if;

  -- Contrôles avant toute écriture : prix, stock, crédit
  for l in select * from jsonb_array_elements(p_lines) loop
    v_prod := resolve_product(l->>'product');
    v_qty := (l->>'qty')::numeric;
    v_price := coalesce(nullif(l->>'price', '')::bigint, v_prod.default_price_xof);
    if v_qty is null or v_qty <= 0 then raise exception 'Quantité invalide pour %', v_prod.name; end if;
    if v_price is null then raise exception 'Prix unitaire requis pour %', v_prod.name; end if;
    select coalesce(sum(b.quantity), 0) into v_avail
      from stock_balances b join lots lo on lo.id = b.lot_id
     where lo.product_id = v_prod.id and lo.owner_client_id is null and b.quantity > 0
       and (v_depot is null or b.depot_id = v_depot) and (lo.expiry_date is null or lo.expiry_date >= current_date);
    if v_avail < v_qty then
      raise exception 'Stock insuffisant pour % : demandé %, disponible %', v_prod.name, v_qty, v_avail;
    end if;
    v_total := v_total + round(v_qty * v_price);
  end loop;

  select coalesce(sum(total_xof - paid_xof), 0) into v_balance
    from invoices where client_id = v_client.id and status in ('emise', 'partielle');
  if v_client.credit_limit_xof > 0 and v_balance + v_total > v_client.credit_limit_xof then
    if not p_force then
      raise exception 'VENTE BLOQUÉE — limite de crédit dépassée pour % : encours % + cette facture % > limite % FCFA',
        v_client.name, v_balance, v_total, v_client.credit_limit_xof;
    end if;
    perform require_role('manager', 'cfo');
    v_forced := true;
  end if;

  v_number := next_invoice_number('vente');
  insert into invoices (number, kind, client_id, issue_date, due_date, status, total_xof, notes, created_by)
  values (v_number, 'vente', v_client.id, current_date,
          current_date + coalesce(p_due_days, v_client.payment_terms_days), 'emise', v_total, p_notes, auth.uid())
  returning id into v_invoice;

  for l in select * from jsonb_array_elements(p_lines) loop
    v_prod := resolve_product(l->>'product');
    v_qty := (l->>'qty')::numeric;
    v_price := coalesce(nullif(l->>'price', '')::bigint, v_prod.default_price_xof);
    v_left := v_qty;
    for r in
      select b.lot_id, b.depot_id, b.quantity, lo.lot_number, lo.expiry_date, coalesce(lo.cost_unit_xof, 0) as cost_xof
        from stock_balances b join lots lo on lo.id = b.lot_id
       where lo.product_id = v_prod.id and lo.owner_client_id is null and b.quantity > 0
         and (v_depot is null or b.depot_id = v_depot) and (lo.expiry_date is null or lo.expiry_date >= current_date)
       order by lo.expiry_date nulls last, lo.created_at
       for update of b
    loop
      exit when v_left <= 0;
      if r.cost_xof > 0 and v_price < r.cost_xof then
        if not p_force then
          raise exception 'VENTE BLOQUÉE — % à % FCFA, sous le prix de revient % FCFA (lot %)',
            v_prod.name, v_price, round(r.cost_xof), r.lot_number;
        end if;
        perform require_role('manager');
        v_forced := true;
      end if;
      v_take := least(r.quantity, v_left);
      insert into stock_movements (lot_id, depot_id, type, qty, reason, client_id, invoice_id, created_by)
      values (r.lot_id, r.depot_id, 'exit', -v_take, 'Vente ' || v_client.name, v_client.id, v_invoice, auth.uid());
      insert into invoice_lines (invoice_id, product_id, lot_id, description, qty, unit_price_xof, cost_xof)
      values (v_invoice, v_prod.id, r.lot_id, v_prod.name || ' — lot ' || r.lot_number, v_take, v_price, round(v_take * r.cost_xof));
      v_picks := v_picks || jsonb_build_object('product', v_prod.name, 'lot_number', r.lot_number, 'qty', v_take);
      v_left := v_left - v_take;
    end loop;
  end loop;

  if v_forced then
    insert into tasks (kind, severity, title, body, dedupe_key)
    values ('anomalie', 'warning', 'Dérogation sur une vente : ' || v_client.name,
            'Facture ' || v_number || ' (' || v_total || ' FCFA) validée malgré une règle de blocage (crédit ou prix de revient).',
            'derogation:' || v_invoice);
  end if;

  return jsonb_build_object('invoice_id', v_invoice, 'invoice_number', v_number, 'client', v_client.name,
                            'total_xof', v_total, 'picks', v_picks);
end $$;

revoke execute on function public.sale_quote(text, jsonb, text), public.create_sale(text, jsonb, text, integer, boolean, text) from public, anon;
grant execute on function public.sale_quote(text, jsonb, text), public.create_sale(text, jsonb, text, integer, boolean, text) to authenticated;

-- Informations de l'entreprise (en-tête des factures)
insert into public.app_settings (key, value) values
  ('company_name', 'OURY DIALLO SARL'), ('company_address', 'Dakar, Sénégal'),
  ('company_phone', ''), ('company_ninea', ''), ('company_rccm', ''), ('invoice_footer', 'Merci pour votre confiance.')
on conflict (key) do nothing;

create or replace function public.set_setting(p_key text, p_value text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_role('admin');
  if p_key not in ('company_name', 'company_address', 'company_phone', 'company_ninea', 'company_rccm', 'invoice_footer') then
    raise exception 'Réglage non modifiable : %', p_key;
  end if;
  insert into app_settings (key, value, updated_at) values (p_key, coalesce(p_value, ''), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
end $$;
revoke execute on function public.set_setting(text, text) from public, anon;
grant execute on function public.set_setting(text, text) to authenticated;
