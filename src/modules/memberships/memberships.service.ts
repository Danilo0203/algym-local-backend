import type { PoolClient } from "pg";

import { withUserTransaction } from "../../db/transaction.js";
import { AppError } from "../../errors/app-error.js";
import type {
  CancelMembershipInput,
  CreateMembershipInput,
  CustomerMembershipResponse,
  MembershipResponse,
  MembershipSummary,
  RenewMembershipInput,
  RenewMembershipResponse,
} from "./memberships.types.js";

const customersViewPermission = "customers.view";
const customersManageMembershipPermission = "customers.manage_membership";

type AuthorizationRow = {
  permissions: string[] | null;
  is_owner: boolean;
};

type PostgresError = Error & {
  code?: string;
  constraint?: string;
};

function isActiveMembershipUniqueViolation(
  error: unknown,
): error is PostgresError {
  const candidate = error as PostgresError;

  return (
    candidate?.code === "23505" &&
    candidate.constraint === "subscriptions_one_active_per_user_idx"
  );
}

function membershipAlreadyActiveError(): AppError {
  return new AppError(
    409,
    "MEMBERSHIP_ALREADY_ACTIVE",
    "El cliente ya tiene una membresía activa",
  );
}

async function getMembershipAuthorization(
  client: PoolClient,
): Promise<AuthorizationRow> {
  const result = await client.query<AuthorizationRow>(
    `
      SELECT
        public.get_current_permissions() AS permissions,
        public.is_owner() AS is_owner
    `,
  );
  return (
    result.rows[0] ?? {
      permissions: [],
      is_owner: false,
    }
  );
}

function assertMembershipReadAccess(auth: AuthorizationRow): void {
  if (
    !auth.is_owner &&
    !(auth.permissions?.includes(customersViewPermission) ?? false)
  ) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "No autorizado para consultar membresías",
    );
  }
}

function assertMembershipWriteAccess(auth: AuthorizationRow): void {
  if (
    !auth.is_owner &&
    !(auth.permissions?.includes(customersManageMembershipPermission) ?? false)
  ) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "No autorizado para administrar membresías",
    );
  }
}

async function getCustomerProfileForMembership(
  client: PoolClient,
  customerId: string,
) {
  const result = await client.query(
    `
      SELECT id, role, is_active
      FROM public.profiles
      WHERE id = $1
    `,
    [customerId],
  );

  const profile = result.rows[0];

  if (!profile) {
    throw new AppError(404, "CUSTOMER_NOT_FOUND", "Cliente no encontrado");
  }

  if (profile.role !== "client") {
    throw new AppError(
      422,
      "INVALID_MEMBERSHIP_OPERATION",
      "El perfil no es un cliente",
    );
  }

  return profile;
}

async function getPlanForMembership(
  client: PoolClient,
  planId: number,
  requireActive = false,
) {
  const result = await client.query(
    `
      SELECT id, name, price, duration_days, is_active
      FROM public.plans
      WHERE id = $1
    `,
    [planId],
  );

  const plan = result.rows[0];

  if (!plan) {
    throw new AppError(404, "PLAN_NOT_FOUND", "Plan no encontrado");
  }

  if (requireActive && !plan.is_active) {
    throw new AppError(422, "PLAN_INACTIVE", "El plan no está activo");
  }

  return plan;
}

async function expirePastDueActiveMemberships(
  client: PoolClient,
  customerId: string,
): Promise<void> {
  await client.query(
    `
      UPDATE public.subscriptions
      SET status = 'expired'
      WHERE user_id = $1
        AND status = 'active'
        AND public.subscription_access_until(end_date, grace_days) < CURRENT_DATE
    `,
    [customerId],
  );
}

async function getCurrentEffectiveMembership(
  client: PoolClient,
  customerId: string,
) {
  const result = await client.query(
    `
      SELECT
        s.id,
        s.plan_id,
        pl.name AS plan_name,
        TO_CHAR(s.start_date, 'YYYY-MM-DD') AS start_date,
        TO_CHAR(s.end_date, 'YYYY-MM-DD') AS end_date,
        s.grace_days,
        TO_CHAR(public.subscription_access_until(s.end_date, s.grace_days), 'YYYY-MM-DD') AS access_until,
        s.status,
        (
          CASE
            WHEN s.status = 'cancelled' THEN 'cancelled'
            WHEN s.status = 'active' THEN
              CASE
                WHEN CURRENT_DATE > s.end_date AND CURRENT_DATE <= public.subscription_access_until(s.end_date, s.grace_days) THEN 'grace'
                WHEN s.end_date - CURRENT_DATE <= 5 THEN 'expiring'
                ELSE 'active'
              END
            ELSE 'expired'
          END
        ) AS display_status,
        ROUND((s.end_date - s.start_date)::numeric / NULLIF(pl.duration_days, 0))::int AS cycles,
        (pl.price * ROUND((s.end_date - s.start_date)::numeric / NULLIF(pl.duration_days, 0))) AS price,
        s.created_at
      FROM public.subscriptions s
      JOIN public.plans pl ON s.plan_id = pl.id
      WHERE s.user_id = $1 AND s.status = 'active'
      LIMIT 1
    `,
    [customerId],
  );

  return result.rows[0] ?? null;
}

function getGuatemalaToday(): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Guatemala",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

async function resolveCreateStartDate(
  client: PoolClient,
  requestedStartDate?: string,
): Promise<string> {
  if (requestedStartDate) {
    return requestedStartDate;
  }
  return getGuatemalaToday();
}

async function resolveRenewStartDate(
  client: PoolClient,
  currentMembership: any,
  requestedStartDate?: string,
): Promise<string> {
  if (requestedStartDate) {
    return requestedStartDate;
  }
  if (currentMembership && currentMembership.status === "active") {
    // Return currentMembership.end_date + 1 day
    const result = await client.query(
      `SELECT TO_CHAR($1::date + interval '1 day', 'YYYY-MM-DD') AS next_day`,
      [currentMembership.end_date],
    );
    return result.rows[0].next_day;
  }
  return getGuatemalaToday();
}

async function mapMembershipResponse(
  client: PoolClient,
  membershipId: string,
): Promise<MembershipSummary> {
  const result = await client.query(
    `
      SELECT
        s.id,
        s.plan_id,
        pl.name AS plan_name,
        TO_CHAR(s.start_date, 'YYYY-MM-DD') AS start_date,
        TO_CHAR(s.end_date, 'YYYY-MM-DD') AS end_date,
        s.grace_days,
        TO_CHAR(public.subscription_access_until(s.end_date, s.grace_days), 'YYYY-MM-DD') AS access_until,
        s.status,
        (
          CASE
            WHEN s.status = 'cancelled' THEN 'cancelled'
            WHEN s.status = 'active' THEN
              CASE
                WHEN CURRENT_DATE > s.end_date AND CURRENT_DATE <= public.subscription_access_until(s.end_date, s.grace_days) THEN 'grace'
                WHEN s.end_date - CURRENT_DATE <= 5 THEN 'expiring'
                ELSE 'active'
              END
            ELSE 'expired'
          END
        ) AS display_status,
        ROUND((s.end_date - s.start_date)::numeric / NULLIF(pl.duration_days, 0))::int AS cycles,
        (pl.price * ROUND((s.end_date - s.start_date)::numeric / NULLIF(pl.duration_days, 0))) AS price,
        s.created_at
      FROM public.subscriptions s
      JOIN public.plans pl ON s.plan_id = pl.id
      WHERE s.id = $1
    `,
    [membershipId],
  );
  return result.rows[0];
}

export async function getCustomerMembership(
  actorUserId: string,
  customerId: string,
): Promise<CustomerMembershipResponse> {
  return withUserTransaction(actorUserId, async (client) => {
    const auth = await getMembershipAuthorization(client);
    assertMembershipReadAccess(auth);

    await getCustomerProfileForMembership(client, customerId);

    await expirePastDueActiveMemberships(client, customerId);
    const currentMembership = await getCurrentEffectiveMembership(
      client,
      customerId,
    );

    return {
      customer_id: customerId,
      current_membership: currentMembership,
    };
  });
}

export async function createMembership(
  actorUserId: string,
  customerId: string,
  input: CreateMembershipInput,
): Promise<MembershipResponse> {
  return withUserTransaction(actorUserId, async (client) => {
    const auth = await getMembershipAuthorization(client);
    assertMembershipWriteAccess(auth);

    const summary = await createMembershipForCustomerInTransaction(
      client,
      customerId,
      input,
    );

    return {
      customer_id: customerId,
      membership: summary,
    };
  });
}

export async function createMembershipForCustomerInTransaction(
  client: PoolClient,
  customerId: string,
  input: CreateMembershipInput,
): Promise<MembershipSummary> {
  const profile = await getCustomerProfileForMembership(client, customerId);
  if (!profile.is_active) {
    throw new AppError(409, "CUSTOMER_INACTIVE", "El cliente está inactivo");
  }

  const plan = await getPlanForMembership(client, input.plan_id, true);

  await expirePastDueActiveMemberships(client, customerId);
  const activeMembership = await getCurrentEffectiveMembership(
    client,
    customerId,
  );

  if (activeMembership) {
    throw membershipAlreadyActiveError();
  }

  const startDate = await resolveCreateStartDate(client, input.start_date);
  const graceDays = 3;

  let result;

  try {
    result = await client.query(
      `
        INSERT INTO public.subscriptions (
          user_id, plan_id, start_date, end_date, status, grace_days
        )
        VALUES (
          $1, $2, $3::date, $3::date + ($4::int * $5::int), 'active', $6
        )
        RETURNING id
      `,
      [
        customerId,
        plan.id,
        startDate,
        plan.duration_days,
        input.cycles,
        graceDays,
      ],
    );
  } catch (error) {
    if (isActiveMembershipUniqueViolation(error)) {
      throw membershipAlreadyActiveError();
    }

    throw error;
  }

  const membershipId = result.rows[0].id;
  const summary = await mapMembershipResponse(client, membershipId);

  return summary;
}

export async function renewMembership(
  actorUserId: string,
  customerId: string,
  input: RenewMembershipInput,
): Promise<RenewMembershipResponse> {
  return withUserTransaction(actorUserId, async (client) => {
    const auth = await getMembershipAuthorization(client);
    assertMembershipWriteAccess(auth);

    const profile = await getCustomerProfileForMembership(client, customerId);
    if (!profile.is_active) {
      throw new AppError(409, "CUSTOMER_INACTIVE", "El cliente está inactivo");
    }

    const plan = await getPlanForMembership(client, input.plan_id, true);

    await expirePastDueActiveMemberships(client, customerId);
    const activeMembership = await getCurrentEffectiveMembership(
      client,
      customerId,
    );

    const latestMembershipResult = await client.query<{ id: string }>(
      `
        SELECT id
        FROM public.subscriptions
        WHERE user_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `,
      [customerId],
    );
    const latestMembershipId = latestMembershipResult.rows[0]?.id;

    if (!latestMembershipId) {
      throw new AppError(
        409,
        "NO_MEMBERSHIP_TO_RENEW",
        "El cliente no tiene una membresía previa para renovar",
      );
    }

    const previousMembershipId = activeMembership?.id ?? latestMembershipId;

    if (activeMembership) {
      await client.query(
        `
          UPDATE public.subscriptions
          SET status = 'expired'
          WHERE id = $1
        `,
        [activeMembership.id],
      );
    }

    const startDate = await resolveRenewStartDate(
      client,
      activeMembership,
      input.start_date,
    );
    const graceDays = 3;

    let result;

    try {
      result = await client.query(
        `
          INSERT INTO public.subscriptions (
            user_id, plan_id, start_date, end_date, status, grace_days
          )
          VALUES (
            $1, $2, $3::date, $3::date + ($4::int * $5::int), 'active', $6
          )
          RETURNING id
        `,
        [
          customerId,
          plan.id,
          startDate,
          plan.duration_days,
          input.cycles,
          graceDays,
        ],
      );
    } catch (error) {
      if (isActiveMembershipUniqueViolation(error)) {
        throw membershipAlreadyActiveError();
      }

      throw error;
    }

    const membershipId = result.rows[0].id;
    const summary = await mapMembershipResponse(client, membershipId);

    return {
      customer_id: customerId,
      membership: summary,
      previous_membership_id: previousMembershipId,
    };
  });
}

export async function cancelMembership(
  actorUserId: string,
  customerId: string,
  input: CancelMembershipInput,
): Promise<MembershipResponse> {
  return withUserTransaction(actorUserId, async (client) => {
    const auth = await getMembershipAuthorization(client);
    assertMembershipWriteAccess(auth);

    await getCustomerProfileForMembership(client, customerId);
    await expirePastDueActiveMemberships(client, customerId);

    const activeMembership = await getCurrentEffectiveMembership(
      client,
      customerId,
    );

    if (!activeMembership) {
      throw new AppError(
        404,
        "ACTIVE_MEMBERSHIP_NOT_FOUND",
        "No existe membresía activa para cancelar",
      );
    }

    await client.query(
      `
        UPDATE public.subscriptions
        SET status = 'cancelled'
        WHERE id = $1
      `,
      [activeMembership.id],
    );

    const summary = await mapMembershipResponse(client, activeMembership.id);

    return {
      customer_id: customerId,
      membership: summary,
    };
  });
}
