import { z } from "zod";

export const loginBodySchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email(),
  password: z.string().min(1).max(256),
});

export const sessionTokenSchema = z
  .string()
  .max(128)
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/i,
  );

export type LoginBody = z.infer<typeof loginBodySchema>;
