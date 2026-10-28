import type { PoolClient } from "pg";
import { withUserTransaction } from "../../db/transaction.js";
import { AppError } from "../../errors/app-error.js";

async function readProgress(client: PoolClient, userId: string, routineId: string) {
  const result = await client.query<{ detail_id: string }>(
    `SELECT completion.detail_id
     FROM public.routine_exercise_completions AS completion
     JOIN public.routine_details AS detail ON detail.id = completion.detail_id
     WHERE completion.user_id = $1 AND detail.routine_id = $2
     ORDER BY completion.detail_id`,
    [userId, routineId],
  );
  return { routineId, completedDetailIds: result.rows.map((row) => Number(row.detail_id)) };
}

export function getOwnRoutineProgress(userId: string, routineId: string) {
  return withUserTransaction(userId, (client) => readProgress(client, userId, routineId));
}

async function lockOwnActiveRoutine(client: PoolClient, userId: string, routineId: string) {
  // Share the manager's lock so a reset, replacement and checkmark cannot interleave.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [userId]);
  const result = await client.query(
    `SELECT routine.id FROM public.routines AS routine
     JOIN public.profiles AS profile ON profile.id = routine.user_id
     WHERE routine.id = $1 AND routine.user_id = $2
       AND routine.status = 'active' AND profile.role = 'client'`,
    [routineId, userId],
  );
  if (!result.rowCount) {
    throw new AppError(404, "ROUTINE_NOT_FOUND", "La rutina activa ya no está disponible. Actualiza la página.");
  }
}

export function setOwnExerciseCompletion(userId: string, routineId: string, detailId: number, completed: boolean) {
  return withUserTransaction(userId, async (client) => {
    await lockOwnActiveRoutine(client, userId, routineId);
    const detail = await client.query(
      "SELECT id FROM public.routine_details WHERE id = $1 AND routine_id = $2",
      [detailId, routineId],
    );
    if (!detail.rowCount) throw new AppError(404, "EXERCISE_NOT_FOUND", "El ejercicio ya no está en tu rutina.");
    if (completed) {
      await client.query(
        `INSERT INTO public.routine_exercise_completions (user_id, detail_id)
         VALUES ($1, $2) ON CONFLICT (user_id, detail_id) DO NOTHING`,
        [userId, detailId],
      );
    } else {
      await client.query("DELETE FROM public.routine_exercise_completions WHERE user_id = $1 AND detail_id = $2", [userId, detailId]);
    }
    return readProgress(client, userId, routineId);
  });
}

export function resetOwnRoutineDay(userId: string, routineId: string, day: number) {
  return withUserTransaction(userId, async (client) => {
    await lockOwnActiveRoutine(client, userId, routineId);
    const details = await client.query(
      "SELECT id FROM public.routine_details WHERE routine_id = $1 AND day_of_week = $2",
      [routineId, day],
    );
    if (!details.rowCount) throw new AppError(404, "DAY_NOT_FOUND", "El día no tiene ejercicios en tu rutina.");
    await client.query(
      `DELETE FROM public.routine_exercise_completions AS completion
       USING public.routine_details AS detail
       WHERE completion.detail_id = detail.id AND completion.user_id = $1
         AND detail.routine_id = $2 AND detail.day_of_week = $3`,
      [userId, routineId, day],
    );
    return readProgress(client, userId, routineId);
  });
}
