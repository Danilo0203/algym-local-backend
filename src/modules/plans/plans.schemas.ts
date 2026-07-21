import { z } from "zod";

export const planIdParamSchema = z.coerce.number().int().positive("Id de plan inválido");
