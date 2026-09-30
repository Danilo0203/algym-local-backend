import type { PoolClient } from "pg";

import { withUserTransaction } from "../../db/transaction.js";
import { AppError } from "../../errors/app-error.js";
import type { CreatePlanInput, UpdatePlanInput } from "./plans.schemas.js";
import type { Plan, PlansListResponse } from "./plans.types.js";

type AuthorizationRow = {
  permissions: string[] | null;
  is_owner: boolean;
};

async function getAuthorization(
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

function hasPermission(
  auth: AuthorizationRow,
  permission: string,
): boolean {
  return auth.is_owner || (auth.permissions?.includes(permission) ?? false);
}

const plansViewPermission = "plans.view";

type PlanRow = Omit<Plan, "price"> & { price: string };

const planColumns = `id, name, description, price, duration_days, is_active`;

function toPlan(row: PlanRow): Plan {
  return { ...row, price: Number(row.price) };
}

function requirePermission(auth: AuthorizationRow, permission: string): void {
  if (!hasPermission(auth, permission)) {
    throw new AppError(403, "FORBIDDEN", "No autorizado para administrar planes");
  }
}

export async function listPlans(
  actorUserId: string,
): Promise<PlansListResponse> {
  return withUserTransaction(actorUserId, async (client) => {
    const auth = await getAuthorization(client);

    if (!hasPermission(auth, plansViewPermission)) {
      throw new AppError(
        403,
        "FORBIDDEN",
        "No autorizado para consultar planes",
      );
    }

    const result = await client.query<PlanRow>(
      `
        SELECT ${planColumns}
        FROM public.plans
        ORDER BY id ASC
      `,
    );

    return {
      data: result.rows.map(toPlan),
    };
  });
}

export async function getPlanById(
  actorUserId: string,
  planId: number,
): Promise<Plan> {
  return withUserTransaction(actorUserId, async (client) => {
    const auth = await getAuthorization(client);

    if (!hasPermission(auth, plansViewPermission)) {
      throw new AppError(
        403,
        "FORBIDDEN",
        "No autorizado para consultar planes",
      );
    }

    const result = await client.query<PlanRow>(
      `
        SELECT ${planColumns}
        FROM public.plans
        WHERE id = $1
      `,
      [planId],
    );

    const plan = result.rows[0];

    if (!plan) {
      throw new AppError(404, "PLAN_NOT_FOUND", "Plan no encontrado");
    }

    return toPlan(plan);
  });
}

export async function createPlan(actorUserId: string, input: CreatePlanInput): Promise<Plan> {
  return withUserTransaction(actorUserId, async (client) => {
    const auth = await getAuthorization(client);
    requirePermission(auth, plansViewPermission);
    requirePermission(auth, "plans.create");

    const result = await client.query<PlanRow>(
      `INSERT INTO public.plans (name, description, price, duration_days, is_active)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${planColumns}`,
      [input.name, input.description, input.price, input.duration_days, input.is_active],
    );
    return toPlan(result.rows[0]!);
  });
}

export async function updatePlan(
  actorUserId: string,
  planId: number,
  input: UpdatePlanInput,
): Promise<Plan> {
  return withUserTransaction(actorUserId, async (client) => {
    const auth = await getAuthorization(client);
    requirePermission(auth, plansViewPermission);
    requirePermission(auth, "plans.update");

    const result = await client.query<PlanRow>(
      `UPDATE public.plans
       SET name = COALESCE($2, name),
           description = CASE WHEN $3 THEN $4 ELSE description END,
           price = COALESCE($5, price),
           duration_days = COALESCE($6, duration_days),
           is_active = COALESCE($7, is_active)
       WHERE id = $1
       RETURNING ${planColumns}`,
      [
        planId,
        input.name ?? null,
        Object.hasOwn(input, "description"),
        input.description ?? null,
        input.price ?? null,
        input.duration_days ?? null,
        input.is_active ?? null,
      ],
    );
    const plan = result.rows[0];
    if (!plan) throw new AppError(404, "PLAN_NOT_FOUND", "Plan no encontrado");
    return toPlan(plan);
  });
}

export async function deactivatePlan(actorUserId: string, planId: number): Promise<Plan> {
  return withUserTransaction(actorUserId, async (client) => {
    const auth = await getAuthorization(client);
    requirePermission(auth, plansViewPermission);
    requirePermission(auth, "plans.delete");

    const result = await client.query<PlanRow>(
      `UPDATE public.plans SET is_active = false WHERE id = $1
       RETURNING ${planColumns}`,
      [planId],
    );
    const plan = result.rows[0];
    if (!plan) throw new AppError(404, "PLAN_NOT_FOUND", "Plan no encontrado");
    return toPlan(plan);
  });
}
