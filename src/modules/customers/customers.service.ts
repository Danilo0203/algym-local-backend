import type { PoolClient } from "pg";

import { withUserTransaction } from "../../db/transaction.js";
import { AppError } from "../../errors/app-error.js";
import { createMembershipForCustomerInTransaction } from "../memberships/memberships.service.js";
import {
  customerCreateSchema,
  customerDetailSchema,
  customerListItemSchema,
  customerSidebarQuerySchema,
  customerStatusUpdateSchema,
  customerUpdateSchema,
  customersListQuerySchema,
  customersListResponseSchema,
} from "./customers.schemas.js";
import type {
  CustomerCreateInput,
  CustomerDetail,
  CustomerListItem,
  CustomerSidebarResponse,
  CustomersListResponse,
  CustomerUpdateInput,
} from "./customers.types.js";

type CustomerAuthorizationRow = {
  permissions: string[] | null;
  is_owner: boolean;
};

type CustomerListRow = {
  id: string;
  email: string | null;
  full_name: string;
  phone: string;
  avatar_url: string | null;
  birth_date: string;
  gender: "male" | "female" | "other";
  is_active: boolean;
  biometric_id: number;
  membership_status:
    | "active"
    | "expiring"
    | "grace"
    | "expired"
    | "cancelled"
    | "none";
  last_check_in: Date | null;
  created_at: Date | null;
  updated_at: Date | null;
  plan_name: string | null;
  plan_id: string | number | null;
  subscription_status: string | null;
  subscription_start_date: string | null;
  subscription_end_date: string | null;
  subscription_grace_days: number | null;
  subscription_access_until: string | null;
};

type CustomerDetailRow = CustomerListRow & {
  role: string;
  injuries: string | null;
  medical_notes: string | null;
  has_password: boolean;
  login_enabled: boolean;
};

type CountRow = {
  total: string;
};

type CreateCustomerRow = {
  customer_id: string;
};

type QueryableError = {
  code?: string;
  detail?: string;
  message?: string;
};

const customersViewPermission = "customers.view";
const customersCreatePermission = "customers.create";
const customersUpdatePermission = "customers.update";
const customersManageMembershipPermission = "customers.manage_membership";
const paymentsViewPermission = "payments.view";

const customerNotFoundError = new AppError(
  404,
  "CUSTOMER_NOT_FOUND",
  "Cliente no encontrado",
);

const invalidSortError = new AppError(
  400,
  "INVALID_SORT",
  "Parámetro sort inválido",
);

const emailAlreadyExistsError = new AppError(
  409,
  "EMAIL_ALREADY_EXISTS",
  "Ya existe un cliente con ese email",
);

const forbiddenViewError = new AppError(
  403,
  "FORBIDDEN",
  "No autorizado para consultar clientes",
);

const forbiddenCreateError = new AppError(
  403,
  "FORBIDDEN",
  "No autorizado para crear clientes",
);

const forbiddenUpdateError = new AppError(
  403,
  "FORBIDDEN",
  "No autorizado para editar clientes",
);

const effectiveMembershipStatusSql = `
  CASE
    WHEN overview.subscription_display_status = 'pending' THEN 'none'
    ELSE overview.subscription_display_status
  END
`;

const customerSortMap = {
  full_name: "overview.full_name",
  "-full_name": "overview.full_name DESC",
  created_at: "profiles.created_at",
  "-created_at": "profiles.created_at DESC",
  updated_at: "profiles.updated_at",
  "-updated_at": "profiles.updated_at DESC",
  last_check_in: "last_attendance.last_check_in",
  "-last_check_in": "last_attendance.last_check_in DESC NULLS LAST",
  membership_status: effectiveMembershipStatusSql,
  "-membership_status": `${effectiveMembershipStatusSql} DESC`,
} as const;

const customerUpdateColumnMap = {
  full_name: "full_name",
  phone: "phone",
  birth_date: "birth_date",
  gender: "gender",
  injuries: "injuries",
  medical_notes: "medical_notes",
} as const satisfies Record<
  keyof CustomerUpdateInput,
  string
>;

async function getAuthorization(
  client: PoolClient,
): Promise<CustomerAuthorizationRow> {
  const result = await client.query<CustomerAuthorizationRow>(
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
  authorization: CustomerAuthorizationRow,
  permission: string,
): boolean {
  return (
    authorization.is_owner ||
    (authorization.permissions ?? []).includes(permission)
  );
}

function assertViewAccess(
  authorization: CustomerAuthorizationRow,
): void {
  if (hasPermission(authorization, customersViewPermission)) {
    return;
  }

  throw forbiddenViewError;
}

function assertCreateAccess(
  authorization: CustomerAuthorizationRow,
): void {
  if (hasPermission(authorization, customersCreatePermission)) {
    return;
  }

  throw forbiddenCreateError;
}

function assertUpdateAccess(
  authorization: CustomerAuthorizationRow,
): void {
  if (hasPermission(authorization, customersUpdatePermission)) {
    return;
  }

  throw forbiddenUpdateError;
}

function resolveSortClause(sort: string): string {
  const clause = customerSortMap[
    sort as keyof typeof customerSortMap
  ];

  if (!clause) {
    throw invalidSortError;
  }

  return `${clause}, overview.id`;
}

function normalizeMembership(row: CustomerListRow): {
  plan_id: number | null;
  plan_name: string | null;
  status: string | null;
  display_status: CustomerListRow["membership_status"];
  start_date: string | null;
  end_date: string | null;
  grace_days: number | null;
  access_until: string | null;
} | null {
  if (
    row.plan_name === null &&
    row.subscription_status === null &&
    row.subscription_start_date === null &&
    row.subscription_end_date === null &&
    row.subscription_grace_days === null &&
    row.subscription_access_until === null
  ) {
    return null;
  }

  return {
    plan_id: row.plan_id === null ? null : Number(row.plan_id),
    plan_name: row.plan_name,
    status: row.subscription_status,
    display_status: row.membership_status,
    start_date: row.subscription_start_date,
    end_date: row.subscription_end_date,
    grace_days: row.subscription_grace_days,
    access_until: row.subscription_access_until,
  };
}

function mapCustomerListItem(row: CustomerListRow): CustomerListItem {
  return customerListItemSchema.parse({
    id: row.id,
    email: row.email,
    full_name: row.full_name,
    phone: row.phone,
    avatar_url: row.avatar_url,
    birth_date: row.birth_date,
    gender: row.gender,
    biometric_id: row.biometric_id,
    is_active: row.is_active,
    membership_status: row.membership_status,
    last_check_in: row.last_check_in?.toISOString() ?? null,
    created_at: row.created_at?.toISOString() ?? null,
    updated_at: row.updated_at?.toISOString() ?? null,
    current_membership: normalizeMembership(row),
  });
}

function mapCustomerDetail(
  row: CustomerDetailRow,
  authorization: CustomerAuthorizationRow,
): CustomerDetail {
  return customerDetailSchema.parse({
    ...mapCustomerListItem(row),
    role: row.role,
    injuries: row.injuries,
    medical_notes: row.medical_notes,
    account: {
      email: row.email,
      has_password: row.has_password,
      login_enabled: row.login_enabled,
    },
    capabilities: {
      update_customer: hasPermission(
        authorization,
        customersUpdatePermission,
      ),
      manage_membership: hasPermission(
        authorization,
        customersManageMembershipPermission,
      ),
      view_payments: hasPermission(authorization, paymentsViewPermission),
    },
  });
}

async function getCustomerDetailRow(
  client: PoolClient,
  customerId: string,
): Promise<CustomerDetailRow | null> {
  const result = await client.query<CustomerDetailRow>(
    `
      SELECT
        overview.id,
        users.email,
        overview.full_name,
        overview.phone,
        overview.avatar_url,
        to_char(overview.birth_date, 'YYYY-MM-DD') AS birth_date,
        overview.gender::text AS gender,
        overview.is_active,
        profiles.biometric_id,
        ${effectiveMembershipStatusSql} AS membership_status,
        last_attendance.last_check_in,
        profiles.created_at,
        profiles.updated_at,
        overview.plan_name,
        overview.plan_id,
        overview.subscription_status,
        to_char(
          overview.subscription_start_date,
          'YYYY-MM-DD'
        ) AS subscription_start_date,
        to_char(
          overview.subscription_end_date,
          'YYYY-MM-DD'
        ) AS subscription_end_date,
        overview.subscription_grace_days,
        to_char(
          overview.subscription_access_until,
          'YYYY-MM-DD'
        ) AS subscription_access_until,
        profiles.role::text AS role,
        profiles.injuries,
        profiles.medical_notes,
        users.encrypted_password IS NOT NULL AS has_password,
        users.email IS NOT NULL
          AND users.encrypted_password IS NOT NULL
          AND users.deleted_at IS NULL AS login_enabled
      FROM public.customer_overview AS overview
      INNER JOIN public.profiles AS profiles
        ON profiles.id = overview.id
      INNER JOIN auth.users AS users
        ON users.id = overview.id
      LEFT JOIN LATERAL (
        SELECT attendance.punch_time AS last_check_in
        FROM public.attendance_logs AS attendance
        WHERE attendance.biometric_id = profiles.biometric_id
          AND (
            NOT (
              lower(coalesce(attendance.raw_line, '')) LIKE '%pin=%'
              AND lower(coalesce(attendance.raw_line, '')) LIKE '%event=%'
            )
            OR attendance.status1 IS NULL
            OR attendance.status1 = 0
          )
        ORDER BY attendance.punch_time DESC, attendance.id DESC
        LIMIT 1
      ) AS last_attendance ON true
      WHERE overview.id = $1
        AND users.deleted_at IS NULL
      LIMIT 1
    `,
    [customerId],
  );

  return result.rows[0] ?? null;
}

function buildCustomerUpdateQuery(input: CustomerUpdateInput): {
  assignments: string[];
  values: Array<string>;
} {
  const assignments: string[] = [];
  const values: Array<string> = [];

  for (const [field, column] of Object.entries(
    customerUpdateColumnMap,
  ) as Array<[keyof CustomerUpdateInput, string]>) {
    const value = input[field];

    if (value === undefined) {
      continue;
    }

    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  }

  return {
    assignments,
    values,
  };
}

function translateCustomerError(error: unknown): never {
  const queryableError = error as QueryableError;

  if (
    queryableError?.message === "EMAIL_ALREADY_EXISTS" ||
    queryableError?.detail === "EMAIL_ALREADY_EXISTS"
  ) {
    throw emailAlreadyExistsError;
  }

  if (queryableError?.message === "FORBIDDEN") {
    throw forbiddenCreateError;
  }

  throw error;
}

export async function listCustomers(
  actorUserId: string,
  query: unknown,
): Promise<CustomersListResponse> {
  return withUserTransaction(actorUserId, async (client) => {
    const authorization = await getAuthorization(client);
    assertViewAccess(authorization);

    const parsedQuery = customersListQuerySchema.parse(query);
    const sortClause = resolveSortClause(parsedQuery.sort);
    const normalizedSearch = parsedQuery.search?.trim() ?? "";
    const limit = parsedQuery.page_size;
    const offset = (parsedQuery.page - 1) * parsedQuery.page_size;

    const countResult = await client.query<CountRow>(
      `
        SELECT count(*)::text AS total
        FROM public.customer_overview AS overview
        INNER JOIN auth.users AS users
          ON users.id = overview.id
        WHERE users.deleted_at IS NULL
          AND ($3::boolean IS NULL OR overview.is_active = $3)
          AND ($4::bigint IS NULL OR overview.plan_id = $4)
          AND ($5::text IS NULL OR ${effectiveMembershipStatusSql} = $5)
          AND (
            $1 = ''
            OR overview.full_name_search LIKE '%' || lower(public.unaccent($1)) || '%'
            OR overview.phone ILIKE '%' || $2 || '%'
            OR lower(coalesce(users.email, '')) LIKE '%' || lower($2) || '%'
          )
      `,
      [
        normalizedSearch,
        normalizedSearch,
        parsedQuery.is_active ?? null,
        parsedQuery.plan_id ?? null,
        parsedQuery.membership_status ?? null,
      ],
    );

    const total = Number.parseInt(
      countResult.rows[0]?.total ?? "0",
      10,
    );

    const listResult = await client.query<CustomerListRow>(
      `
        SELECT
          overview.id,
          users.email,
          overview.full_name,
          overview.phone,
          overview.avatar_url,
          to_char(overview.birth_date, 'YYYY-MM-DD') AS birth_date,
          overview.gender::text AS gender,
          overview.is_active,
          profiles.biometric_id,
          ${effectiveMembershipStatusSql} AS membership_status,
          last_attendance.last_check_in,
          profiles.created_at,
          profiles.updated_at,
          overview.plan_name,
          overview.plan_id,
          overview.subscription_status,
          to_char(
            overview.subscription_start_date,
            'YYYY-MM-DD'
          ) AS subscription_start_date,
          to_char(
            overview.subscription_end_date,
            'YYYY-MM-DD'
          ) AS subscription_end_date,
          overview.subscription_grace_days,
          to_char(
            overview.subscription_access_until,
            'YYYY-MM-DD'
          ) AS subscription_access_until
        FROM public.customer_overview AS overview
        INNER JOIN public.profiles AS profiles
          ON profiles.id = overview.id
        INNER JOIN auth.users AS users
          ON users.id = overview.id
        LEFT JOIN LATERAL (
          SELECT attendance.punch_time AS last_check_in
          FROM public.attendance_logs AS attendance
          WHERE attendance.biometric_id = profiles.biometric_id
            AND (
              NOT (
                lower(coalesce(attendance.raw_line, '')) LIKE '%pin=%'
                AND lower(coalesce(attendance.raw_line, '')) LIKE '%event=%'
              )
              OR attendance.status1 IS NULL
              OR attendance.status1 = 0
            )
          ORDER BY attendance.punch_time DESC, attendance.id DESC
          LIMIT 1
        ) AS last_attendance ON true
        WHERE users.deleted_at IS NULL
          AND ($3::boolean IS NULL OR overview.is_active = $3)
          AND ($4::bigint IS NULL OR overview.plan_id = $4)
          AND ($5::text IS NULL OR ${effectiveMembershipStatusSql} = $5)
          AND (
            $1 = ''
            OR overview.full_name_search LIKE '%' || lower(public.unaccent($1)) || '%'
            OR overview.phone ILIKE '%' || $2 || '%'
            OR lower(coalesce(users.email, '')) LIKE '%' || lower($2) || '%'
          )
        ORDER BY ${sortClause}
        LIMIT $6
        OFFSET $7
      `,
      [
        normalizedSearch,
        normalizedSearch,
        parsedQuery.is_active ?? null,
        parsedQuery.plan_id ?? null,
        parsedQuery.membership_status ?? null,
        limit,
        offset,
      ],
    );

    const response = {
      data: listResult.rows.map(mapCustomerListItem),
      meta: {
        page: parsedQuery.page,
        page_size: parsedQuery.page_size,
        total,
        total_pages:
          total === 0
            ? 0
            : Math.ceil(total / parsedQuery.page_size),
      },
    };

    return customersListResponseSchema.parse(response);
  });
}

export async function getCustomerById(
  actorUserId: string,
  customerId: string,
): Promise<CustomerDetail> {
  return withUserTransaction(actorUserId, async (client) => {
    const authorization = await getAuthorization(client);
    assertViewAccess(authorization);

    const customer = await getCustomerDetailRow(client, customerId);

    if (!customer) {
      throw customerNotFoundError;
    }

    return mapCustomerDetail(customer, authorization);
  });
}

export async function listCustomerSidebar(
  actorUserId: string,
  query: unknown,
): Promise<CustomerSidebarResponse> {
  return withUserTransaction(actorUserId, async (client) => {
    const authorization = await getAuthorization(client);
    assertViewAccess(authorization);
    const parsedQuery = customerSidebarQuerySchema.parse(query);
    const search = parsedQuery.search?.trim() ?? "";

    const result = await client.query<{
      id: string;
      full_name: string;
      avatar_url: string | null;
      biometric_id: number;
      is_active: boolean;
      membership_status: CustomerListRow["membership_status"];
      plan_name: string | null;
    }>(
      `
        SELECT
          overview.id,
          overview.full_name,
          overview.avatar_url,
          profiles.biometric_id,
          overview.is_active,
          ${effectiveMembershipStatusSql} AS membership_status,
          overview.plan_name
        FROM public.customer_overview AS overview
        INNER JOIN public.profiles AS profiles
          ON profiles.id = overview.id
        INNER JOIN auth.users AS users
          ON users.id = overview.id
        WHERE users.deleted_at IS NULL
          AND (
            $1 = ''
            OR overview.full_name_search LIKE '%' || lower(public.unaccent($1)) || '%'
            OR overview.phone ILIKE '%' || $1 || '%'
            OR lower(coalesce(users.email, '')) LIKE '%' || lower($1) || '%'
          )
        ORDER BY overview.full_name, overview.id
        LIMIT $2
      `,
      [search, parsedQuery.limit],
    );

    return {
      data: result.rows.map((row) => ({
        ...row,
        biometric_id: Number(row.biometric_id),
      })),
    };
  });
}

export async function createCustomer(
  actorUserId: string,
  body: unknown,
): Promise<CustomerDetail> {
  return withUserTransaction(actorUserId, async (client) => {
    const authorization = await getAuthorization(client);
    assertCreateAccess(authorization);

    const input = customerCreateSchema.parse(body);

    if (
      input.membership &&
      !hasPermission(authorization, customersManageMembershipPermission)
    ) {
      throw new AppError(
        403,
        "FORBIDDEN",
        "No autorizado para administrar membresías",
      );
    }

    try {
      const result = await client.query<CreateCustomerRow>(
        `
          SELECT public.create_customer_core(
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7
          ) AS customer_id
        `,
        [
          input.full_name,
          input.phone,
          input.birth_date,
          input.gender,
          input.email ?? null,
          input.injuries ?? null,
          input.medical_notes ?? null,
        ],
      );

      const customerId = result.rows[0]?.customer_id;

      if (!customerId) {
        throw new AppError(
          500,
          "CUSTOMER_CREATE_FAILED",
          "No se pudo crear el cliente",
        );
      }

      if (input.membership) {
        await createMembershipForCustomerInTransaction(
          client,
          customerId,
          input.membership,
        );
      }

      const customer = await getCustomerDetailRow(client, customerId);

      if (!customer) {
        throw new AppError(
          500,
          "CUSTOMER_CREATE_FAILED",
          "No se pudo cargar el cliente creado",
        );
      }

      return mapCustomerDetail(customer, authorization);
    } catch (error) {
      translateCustomerError(error);
    }
  });
}

export async function updateCustomer(
  actorUserId: string,
  customerId: string,
  body: unknown,
): Promise<CustomerDetail> {
  return withUserTransaction(actorUserId, async (client) => {
    const authorization = await getAuthorization(client);
    assertUpdateAccess(authorization);

    const input = customerUpdateSchema.parse(body);
    const { assignments, values } = buildCustomerUpdateQuery(input);

    if (assignments.length === 0) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "Solicitud inválida",
      );
    }

    const existingCustomer = await getCustomerDetailRow(
      client,
      customerId,
    );

    if (!existingCustomer) {
      throw customerNotFoundError;
    }

    const updateResult = await client.query<{ id: string }>(
      `
        UPDATE public.profiles
        SET
          ${assignments.join(", ")},
          updated_at = now()
        WHERE id = $${values.length + 1}
        RETURNING id
      `,
      [...values, customerId],
    );

    if (updateResult.rowCount === 0) {
      throw customerNotFoundError;
    }

    const customer = await getCustomerDetailRow(client, customerId);

    if (!customer) {
      throw customerNotFoundError;
    }

    return mapCustomerDetail(customer, authorization);
  });
}

export async function updateCustomerStatus(
  actorUserId: string,
  customerId: string,
  body: unknown,
): Promise<CustomerDetail> {
  return withUserTransaction(actorUserId, async (client) => {
    const authorization = await getAuthorization(client);
    assertUpdateAccess(authorization);

    const input = customerStatusUpdateSchema.parse(body);

    const existingCustomer = await getCustomerDetailRow(
      client,
      customerId,
    );

    if (!existingCustomer) {
      throw customerNotFoundError;
    }

    const updateResult = await client.query<{ id: string }>(
      `
        UPDATE public.profiles
        SET
          is_active = $1,
          updated_at = now()
        WHERE id = $2
        RETURNING id
      `,
      [input.is_active, customerId],
    );

    if (updateResult.rowCount === 0) {
      throw customerNotFoundError;
    }

    const customer = await getCustomerDetailRow(client, customerId);

    if (!customer) {
      throw customerNotFoundError;
    }

    return mapCustomerDetail(customer, authorization);
  });
}
