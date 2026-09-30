import { z } from "zod";

export const messageIdSchema = z.uuid();

export const messageListQuerySchema = z.object({
  include_inactive: z.enum(["true", "false"]).default("false")
    .transform((value) => value === "true"),
}).strict();

const nameSchema = z.string().trim().min(1).max(120);
const contentSchema = z.string().trim().min(1).max(10_000);

export const createMessageSchema = z.object({
  name: nameSchema,
  content: contentSchema,
}).strict();

export const updateMessageSchema = z.object({
  name: nameSchema.optional(),
  content: contentSchema.optional(),
  is_active: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "Debes enviar al menos un campo",
});

export type CreateMessageInput = z.infer<typeof createMessageSchema>;
export type UpdateMessageInput = z.infer<typeof updateMessageSchema>;
