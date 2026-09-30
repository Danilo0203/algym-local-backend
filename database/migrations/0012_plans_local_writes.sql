BEGIN;

INSERT INTO public.permissions (key, description, module, action)
VALUES
  ('plans.create', 'Permite crear planes de membresía', 'plans', 'create'),
  ('plans.update', 'Permite editar planes de membresía', 'plans', 'update'),
  ('plans.delete', 'Permite desactivar planes de membresía', 'plans', 'delete')
ON CONFLICT (key) DO UPDATE
SET description = EXCLUDED.description,
    module = EXCLUDED.module,
    action = EXCLUDED.action;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM public.roles AS role
CROSS JOIN public.permissions AS permission
WHERE role.slug = 'admin'
  AND permission.key IN ('plans.view', 'plans.create', 'plans.update', 'plans.delete')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- El borrado es lógico: los planes históricos siguen referenciados por membresías.
DROP POLICY IF EXISTS "Only admins can manage plans" ON public.plans;
DROP POLICY IF EXISTS "Local plans insert" ON public.plans;
DROP POLICY IF EXISTS "Local plans update" ON public.plans;

CREATE POLICY "Local plans insert"
ON public.plans
FOR INSERT
TO authenticated
WITH CHECK (
  public.is_owner() OR public.has_permission('plans.create')
);

CREATE POLICY "Local plans update"
ON public.plans
FOR UPDATE
TO authenticated
USING (
  public.is_owner()
  OR public.has_permission('plans.update')
  OR public.has_permission('plans.delete')
)
WITH CHECK (
  public.is_owner()
  OR public.has_permission('plans.update')
  OR public.has_permission('plans.delete')
);

REVOKE INSERT, UPDATE, DELETE ON public.plans FROM anon;
REVOKE DELETE ON public.plans FROM authenticated;

COMMIT;
