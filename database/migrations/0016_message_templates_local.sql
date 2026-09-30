BEGIN;

DROP POLICY IF EXISTS "message_templates_admin_all" ON public.message_templates;

CREATE POLICY message_templates_local_select ON public.message_templates
  FOR SELECT TO algym_app
  USING (
    public.is_owner()
    OR public.has_permission('messages.view')
    OR public.has_permission('messages.create')
    OR public.has_permission('messages.update')
    OR public.has_permission('messages.delete')
  );

CREATE POLICY message_templates_local_insert ON public.message_templates
  FOR INSERT TO algym_app
  WITH CHECK (
    created_by = auth.uid()
    AND (public.is_owner() OR public.has_permission('messages.create'))
  );

CREATE POLICY message_templates_local_update ON public.message_templates
  FOR UPDATE TO algym_app
  USING (public.is_owner() OR public.has_permission('messages.update'))
  WITH CHECK (public.is_owner() OR public.has_permission('messages.update'));

CREATE POLICY message_templates_local_delete ON public.message_templates
  FOR DELETE TO algym_app
  USING (public.is_owner() OR public.has_permission('messages.delete'));

COMMIT;
