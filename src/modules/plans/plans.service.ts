import type { PoolClient } from "pg";

import { withUserTransaction } from "../../db/transaction.js";
import { AppError } from "../../errors/app-error.js";
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

    const result = await client.query<Plan>(
      `
        SELECT
          id,
          name,
          description,
          price,
          duration_days,
          is_active
        FROM public.plans
        ORDER BY id ASC
      `,
    );

    return {
      data: result.rows,
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

    const result = await client.query<Plan>(
      `
        SELECT
          id,
          name,
          description,
          price,
          duration_days,
          is_active
        FROM public.plans
        WHERE id = $1
      `,
      [planId],
    );

    const plan = result.rows[0];

    if (!plan) {
      throw new AppError(404, "PLAN_NOT_FOUND", "Plan no encontrado");
    }

    return plan;
  });
}
