\set ON_ERROR_STOP on

BEGIN;

LOCK TABLE public.device_commands
IN ACCESS EXCLUSIVE MODE;

WITH ranked AS (
  SELECT
    id,
    executed,
    return_code,
    row_number() OVER (
      PARTITION BY
        device_id,
        command,
        executed,
        COALESCE(return_code, '')
      ORDER BY
        created_at DESC NULLS LAST,
        id DESC
    ) AS duplicate_position
  FROM public.device_commands
),
deleted AS (
  DELETE FROM public.device_commands AS commands
  USING ranked
  WHERE commands.id = ranked.id
    AND ranked.executed IS TRUE
    AND btrim(COALESCE(ranked.return_code, '')) = '0'
    AND ranked.duplicate_position > 1
  RETURNING commands.id
)
SELECT count(*) AS removed_duplicate_commands
FROM deleted;

COMMIT;

CREATE INDEX IF NOT EXISTS device_commands_pending_idx
ON public.device_commands (
  device_id,
  created_at DESC,
  id DESC
)
WHERE executed IS DISTINCT FROM true;

CREATE INDEX IF NOT EXISTS device_commands_created_at_idx
ON public.device_commands (created_at DESC);

CREATE INDEX IF NOT EXISTS device_commands_device_result_idx
ON public.device_commands (
  device_id,
  executed,
  return_code,
  created_at DESC
);

ANALYZE public.device_commands;
