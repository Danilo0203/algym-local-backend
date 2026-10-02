import { z } from "zod";

const money = z.number().finite().nonnegative().max(999_999_999.99).refine(
  (value) => Math.abs(Math.round(value * 100) - value * 100) < 1e-7,
  "El importe admite dos decimales",
);
const quantity = z.number().finite().nonnegative().max(999_999_999.999).refine(
  (value) => Math.abs(Math.round(value * 1_000) - value * 1_000) < 1e-6,
  "La cantidad admite tres decimales",
);
const text = z.string().trim().max(120).nullable().optional();
const mediaUrl = z.string().regex(/^\/api\/media\/products\/[a-f0-9]{64}\.(png|jpg|webp|gif)$/);

export const productIdSchema = z.uuid();
export const productListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(10),
  name: z.string().trim().max(120).optional(),
  isActive: z.string().regex(/^(true|false)(,(true|false))*$/).optional(),
}).strict();

const productFields = {
  name: z.string().trim().min(2).max(200),
  sku: text,
  barcode: text,
  costPrice: money,
  salePrice: money,
  isActive: z.boolean(),
  imageUrl: mediaUrl.nullable().optional(),
};
export const createProductSchema = z.object({
  ...productFields,
  initialQuantity: quantity.default(0),
}).strict();
export const updateProductSchema = z.object(productFields).strict();

const productImagePayload = { image_base64: z.string().min(1).max(7_000_000) };
export const createProductWithImageSchema = createProductSchema.omit({ imageUrl: true })
  .extend(productImagePayload).strict();
export const updateProductWithImageSchema = updateProductSchema.omit({ imageUrl: true })
  .extend(productImagePayload).strict();

export function decodeProductImage(base64: string): Buffer {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0 || bytes.length > 5 * 1024 * 1024
    || bytes.toString("base64") !== base64) {
    throw new z.ZodError([{
      code: "custom", path: ["image_base64"],
      message: "La imagen debe estar codificada en base64 y medir como máximo 5 MB",
    }]);
  }
  return bytes;
}

export const inventoryMovementSchema = z.object({
  movementType: z.enum(["entry", "manual_exit"]),
  quantity: quantity.positive(),
  unitCost: money.nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
}).strict();
export const inventoryAdjustmentSchema = z.object({
  countedQuantity: quantity,
  note: z.string().trim().max(500).nullable().optional(),
}).strict();
export const inventoryMovementsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(10),
  productName: z.string().trim().max(120).optional(),
  movementType: z.string().regex(/^(entry|sale|manual_exit|adjustment|void)(,(entry|sale|manual_exit|adjustment|void))*$/).optional(),
}).strict();

export type ProductListQuery = z.infer<typeof productListQuerySchema>;
export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type InventoryMovementInput = z.infer<typeof inventoryMovementSchema>;
export type InventoryAdjustmentInput = z.infer<typeof inventoryAdjustmentSchema>;
export type InventoryMovementsQuery = z.infer<typeof inventoryMovementsQuerySchema>;
