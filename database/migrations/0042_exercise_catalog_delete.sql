BEGIN;
INSERT INTO public.permissions (key, description, module, action)
VALUES ('exercises.delete', 'Eliminar ejercicios del catálogo conservando rutinas existentes', 'exercises', 'delete')
ON CONFLICT (key) DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM public.roles r CROSS JOIN public.permissions p
WHERE r.slug IN ('admin', 'owner') AND p.key = 'exercises.delete'
ON CONFLICT DO NOTHING;
CREATE POLICY local_exercises_archive ON public.exercises FOR UPDATE TO algym_app
USING (public.is_owner() OR public.has_permission('exercises.delete'))
WITH CHECK ((public.is_owner() OR public.has_permission('exercises.delete')) AND is_active = false);
COMMIT;
