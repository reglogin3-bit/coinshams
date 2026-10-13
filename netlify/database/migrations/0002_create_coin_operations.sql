create or replace function public.exchange_user_balance(
  p_user_id uuid,
  p_direction text,
  p_amount bigint
)
returns table (cash_balance bigint, coin_balance bigint, converted_amount bigint)
language plpgsql
as $$
declare
  v_profile public.user_profiles%rowtype;
  v_settings public.coin_settings%rowtype;
  v_cash_delta bigint;
  v_coin_delta bigint;
  v_converted bigint;
begin
  if p_amount <= 0 then raise exception 'Miqdor musbat bo‘lishi kerak'; end if;
  select * into v_profile from public.user_profiles where id = p_user_id for update;
  if not found or v_profile.is_blocked then raise exception 'Hisob faol emas'; end if;
  select * into v_settings from public.coin_settings where id = true;

  if p_direction = 'cash_to_coin' then
    v_converted := p_amount / v_settings.cash_per_coin;
    if v_converted < 1 then raise exception 'Kamida bitta koin qiymatidagi cash kiriting'; end if;
    v_cash_delta := -(v_converted * v_settings.cash_per_coin);
    v_coin_delta := v_converted;
  elsif p_direction = 'coin_to_cash' then
    v_converted := p_amount * v_settings.cash_per_coin;
    v_cash_delta := v_converted;
    v_coin_delta := -p_amount;
  else
    raise exception 'Ayrboshlash yo‘nalishi noto‘g‘ri';
  end if;

  if v_profile.cash_balance + v_cash_delta < 0 or v_profile.coin_balance + v_coin_delta < 0 then
    raise exception 'Balans yetarli emas';
  end if;

  update public.user_profiles
  set cash_balance = cash_balance + v_cash_delta,
      coin_balance = coin_balance + v_coin_delta
  where id = p_user_id
  returning user_profiles.cash_balance, user_profiles.coin_balance
  into cash_balance, coin_balance;

  insert into public.wallet_transactions (user_id, cash_delta, coin_delta, description)
  values (
    p_user_id,
    v_cash_delta,
    v_coin_delta,
    case p_direction
      when 'cash_to_coin' then 'Cash koinlarga ayrboshlangan'
      else 'Koin cashga ayrboshlangan'
    end
  );
  converted_amount := v_converted;
  return next;
end;
$$;

create or replace function public.redeem_coin_reward(p_user_id uuid, p_reward_id bigint)
returns uuid
language plpgsql
as $$
declare
  v_profile public.user_profiles%rowtype;
  v_reward public.coin_rewards%rowtype;
  v_order_id uuid;
begin
  select * into v_profile from public.user_profiles where id = p_user_id for update;
  if not found or v_profile.is_blocked then raise exception 'Hisob faol emas'; end if;
  select * into v_reward from public.coin_rewards where id = p_reward_id and is_active for update;
  if not found then raise exception 'Mukofot faol emas yoki topilmadi'; end if;
  if v_profile.coin_balance < v_reward.cost_coins then raise exception 'Koin balansi yetarli emas'; end if;

  update public.user_profiles set coin_balance = coin_balance - v_reward.cost_coins where id = p_user_id;
  insert into public.wallet_transactions (user_id, coin_delta, description)
  values (p_user_id, -v_reward.cost_coins, 'Mukofot buyurtmasi: ' || v_reward.title);
  insert into public.reward_orders (user_id, reward_id, coins_spent)
  values (p_user_id, p_reward_id, v_reward.cost_coins)
  returning id into v_order_id;
  return v_order_id;
end;
$$;

create or replace function public.update_reward_order_status(p_order_id uuid, p_status text)
returns uuid
language plpgsql
as $$
declare
  v_order public.reward_orders%rowtype;
begin
  if p_status not in ('delivered', 'cancelled') then raise exception 'Buyurtma holati noto‘g‘ri'; end if;
  select * into v_order from public.reward_orders where id = p_order_id for update;
  if not found then raise exception 'Buyurtma topilmadi'; end if;
  if v_order.status = p_status then return v_order.id; end if;
  if v_order.status <> 'pending' then raise exception 'Yakunlangan buyurtma holatini o‘zgartirib bo‘lmaydi'; end if;

  if p_status = 'cancelled' then
    update public.user_profiles set coin_balance = coin_balance + v_order.coins_spent where id = v_order.user_id;
    insert into public.wallet_transactions (user_id, coin_delta, description)
    values (v_order.user_id, v_order.coins_spent, 'Mukofot buyurtmasi bekor qilindi: ' || v_order.id);
  end if;
  update public.reward_orders set status = p_status where id = v_order.id;
  return v_order.id;
end;
$$;

create or replace function public.submit_group_attendance(
  p_session_id uuid,
  p_marked_by uuid,
  p_attendance jsonb
)
returns void
language plpgsql
as $$
declare
  v_session public.group_sessions%rowtype;
  v_settings public.coin_settings%rowtype;
  v_entry jsonb;
  v_user_id uuid;
  v_present boolean;
begin
  select * into v_session from public.group_sessions where id = p_session_id for update;
  if not found then raise exception 'Mashg‘ulot topilmadi'; end if;
  if not exists (
    select 1 from public.user_profiles
    where id = p_marked_by and role in ('admin', 'teacher') and not is_blocked
  ) then raise exception 'Davomat belgilash huquqi yo‘q'; end if;
  select * into v_settings from public.coin_settings where id = true;

  for v_entry in select value from jsonb_array_elements(p_attendance)
  loop
    v_user_id := (v_entry->>'user_id')::uuid;
    v_present := coalesce((v_entry->>'present')::boolean, false);
    if not exists (
      select 1 from public.group_members where group_id = v_session.group_id and user_id = v_user_id
    ) then raise exception 'Davomatda guruhga kirmaydigan foydalanuvchi bor'; end if;

    insert into public.attendance (session_id, user_id, present, marked_by)
    values (p_session_id, v_user_id, v_present, p_marked_by)
    on conflict (session_id, user_id)
    do update set present = excluded.present, marked_by = excluded.marked_by, marked_at = now();

    if v_present and v_settings.auto_attendance_reward
       and (v_settings.attendance_cash > 0 or v_settings.attendance_coins > 0) then
      insert into public.wallet_transactions (
        user_id, cash_delta, coin_delta, description, attendance_session_id
      )
      values (
        v_user_id, v_settings.attendance_cash, v_settings.attendance_coins,
        'Mashg‘ulot davomat mukofoti: ' || v_session.subject, p_session_id
      )
      on conflict (user_id, attendance_session_id) where attendance_session_id is not null
      do nothing;
      if found then
        update public.user_profiles
        set cash_balance = cash_balance + v_settings.attendance_cash,
            coin_balance = coin_balance + v_settings.attendance_coins
        where id = v_user_id;
      end if;
    end if;
  end loop;

  update public.group_sessions
  set status = 'completed', marked_by = p_marked_by, completed_at = now()
  where id = p_session_id;
end;
$$;

create or replace function public.apply_manual_group_reward(
  p_group_id uuid,
  p_cash_amount bigint,
  p_coin_amount bigint,
  p_user_ids uuid[],
  p_description text
)
returns integer
language plpgsql
as $$
declare
  v_user_id uuid;
  v_count integer := 0;
begin
  if p_cash_amount < 0 or p_coin_amount < 0 or (p_cash_amount = 0 and p_coin_amount = 0) then
    raise exception 'Cash yoki koin miqdorini kiriting';
  end if;
  if not exists (select 1 from public.study_groups where id = p_group_id) then
    raise exception 'Guruh topilmadi';
  end if;

  for v_user_id in
    select gm.user_id
    from public.group_members gm
    join public.user_profiles p on p.id = gm.user_id
    where gm.group_id = p_group_id
      and (p_user_ids is null or gm.user_id = any(p_user_ids))
      and not p.is_blocked
  loop
    insert into public.wallet_transactions (user_id, cash_delta, coin_delta, description)
    values (v_user_id, p_cash_amount, p_coin_amount, p_description);
    update public.user_profiles
    set cash_balance = cash_balance + p_cash_amount,
        coin_balance = coin_balance + p_coin_amount
    where id = v_user_id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
