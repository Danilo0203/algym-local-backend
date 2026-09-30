import type { PoolClient } from "pg";

import { withUserTransaction } from "../../db/transaction.js";
import { getOwnRoutineWorkspace } from "../customer-routines/customer-routines.service.js";
import { getProfile } from "../profile/profile.service.js";

type OverviewRow = {
  full_name: string | null;
  phone: string | null;
  avatar_url: string | null;
  gender: string | null;
  birth_date: string | null;
  plan_name: string | null;
  subscription_status: string | null;
  subscription_start_date: string | null;
  subscription_end_date: string | null;
  subscription_grace_days: number | null;
  subscription_access_until: string | null;
  last_check_in: Date | null;
  is_active: boolean | null;
};

async function getOwnOverviewInTransaction(client: PoolClient, actorUserId: string) {
  const result = await client.query<OverviewRow>(
    `SELECT full_name, phone, avatar_url, gender::text AS gender,
            to_char(birth_date, 'YYYY-MM-DD') AS birth_date,
            plan_name, subscription_status::text AS subscription_status,
            to_char(subscription_start_date, 'YYYY-MM-DD') AS subscription_start_date,
            to_char(subscription_end_date, 'YYYY-MM-DD') AS subscription_end_date,
            subscription_grace_days,
            to_char(subscription_access_until, 'YYYY-MM-DD') AS subscription_access_until,
            last_check_in, is_active
     FROM public.customer_overview
     WHERE id = $1
     LIMIT 1`,
    [actorUserId],
  );
  const row = result.rows[0];
  return row ? {
    ...row,
    avatar_url: null,
    last_check_in: row.last_check_in?.toISOString() ?? null,
  } : null;
}

export async function getOwnOverview(actorUserId: string) {
  return withUserTransaction(actorUserId, (client) => getOwnOverviewInTransaction(client, actorUserId));
}

export async function getOwnProfileData(actorUserId: string) {
  const [profile, overview] = await Promise.all([
    getProfile(actorUserId),
    getOwnOverview(actorUserId),
  ]);
  return { ...profile, avatar_url: null, overview };
}

export async function getOwnMembershipData(actorUserId: string) {
  return withUserTransaction(actorUserId, async (client) => {
    const overview = await getOwnOverviewInTransaction(client, actorUserId);
    const result = await client.query<{
      id: string;
      plan_id: string;
      plan_name: string | null;
      start_date: string;
      end_date: string;
      grace_days: number | null;
      access_until: string | null;
      status: string;
      price: string | null;
      discount_amount: string | null;
    }>(
      `SELECT subscription.id, subscription.plan_id::text AS plan_id,
              plan.name AS plan_name,
              to_char(subscription.start_date, 'YYYY-MM-DD') AS start_date,
              to_char(subscription.end_date, 'YYYY-MM-DD') AS end_date,
              subscription.grace_days,
              to_char(public.subscription_access_until(subscription.end_date, subscription.grace_days),
                      'YYYY-MM-DD') AS access_until,
              subscription.status::text AS status,
              plan.price::text AS price,
              subscription.discount_amount::text AS discount_amount
       FROM public.subscriptions AS subscription
       LEFT JOIN public.plans AS plan ON plan.id = subscription.plan_id
       WHERE subscription.user_id = $1
       ORDER BY subscription.created_at DESC, subscription.id DESC
       LIMIT 8`,
      [actorUserId],
    );
    return {
      overview,
      subscriptions: result.rows.map((row) => ({
        id: row.id,
        plan_id: Number(row.plan_id),
        plan_name: row.plan_name ?? "Plan",
        start_date: row.start_date,
        end_date: row.end_date,
        grace_days: row.grace_days,
        access_until: row.access_until,
        status: row.status,
        price: Number(row.price ?? 0),
        discount_amount: Number(row.discount_amount ?? 0),
      })),
    };
  });
}

export async function getOwnRoutineData(actorUserId: string) {
  const [workspace, overview] = await Promise.all([
    getOwnRoutineWorkspace(actorUserId),
    getOwnOverview(actorUserId),
  ]);
  return {
    customer_name: overview?.full_name ?? "Cliente",
    workspace,
  };
}
