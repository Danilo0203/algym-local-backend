import { Router } from "express";

import { AppError } from "../../errors/app-error.js";
import { readSessionTokenFromRequest, validateSessionToken } from "../auth/auth.service.js";
import {
  createProductSchema, inventoryAdjustmentSchema, inventoryMovementSchema,
  inventoryMovementsQuerySchema, productIdSchema, productListQuerySchema,
  updateProductSchema,
} from "./inventory.schemas.js";
import {
  adjustStock, createProduct, deactivateProduct, listMovements, listProducts,
  recordMovement, updateProduct,
} from "./inventory.service.js";

export const inventoryRouter = Router();

inventoryRouter.get("/products", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    response.status(200).json(await listProducts(session.userId, productListQuerySchema.parse(request.query)));
  } catch (error) { next(error); }
});

inventoryRouter.post("/products", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    response.status(201).json(await createProduct(session.userId, createProductSchema.parse(request.body)));
  } catch (error) { next(error); }
});

inventoryRouter.put("/products/:id", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const id = productIdSchema.parse(request.params.id);
    response.status(200).json(await updateProduct(session.userId, id, updateProductSchema.parse(request.body)));
  } catch (error) { next(error); }
});

inventoryRouter.delete("/products/:id", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const id = productIdSchema.parse(request.params.id);
    response.status(200).json(await deactivateProduct(session.userId, id));
  } catch (error) { next(error); }
});

inventoryRouter.post("/products/:id/movements", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const id = productIdSchema.parse(request.params.id);
    response.status(201).json(await recordMovement(session.userId, id, inventoryMovementSchema.parse(request.body)));
  } catch (error) { next(error); }
});

inventoryRouter.post("/products/:id/adjust", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const id = productIdSchema.parse(request.params.id);
    response.status(201).json(await adjustStock(session.userId, id, inventoryAdjustmentSchema.parse(request.body)));
  } catch (error) { next(error); }
});

inventoryRouter.get("/movements", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    response.status(200).json(await listMovements(session.userId, inventoryMovementsQuerySchema.parse(request.query)));
  } catch (error) { next(error); }
});

inventoryRouter.use((_request, _response, next) => {
  next(new AppError(405, "METHOD_NOT_ALLOWED", "Método no permitido"));
});
