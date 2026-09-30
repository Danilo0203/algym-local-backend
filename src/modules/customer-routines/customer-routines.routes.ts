import { Router } from "express";

import { AppError } from "../../errors/app-error.js";
import {
  readSessionTokenFromRequest,
  validateSessionToken,
} from "../auth/auth.service.js";
import { customerIdParamSchema } from "../customers/customers.schemas.js";
import {
  createCustomerRoutineSchema,
  createRoutineDetailSchema,
  generateCustomerRoutineSchema,
  routineDetailIdParamSchema,
  routineIdParamSchema,
  updateCustomerRoutineSchema,
  updateRoutineDetailSchema,
} from "./customer-routines.schemas.js";
import {
  createCustomerRoutine,
  createRoutineDetail,
  deleteRoutineDetail,
  generateCustomerRoutine,
  updateCustomerRoutine,
  updateRoutineDetail,
} from "./customer-routines.service.js";

export const customerRoutinesRouter = Router({ mergeParams: true });

function parseParams(params: Record<string, string | undefined>) {
  return {
    customerId: customerIdParamSchema.parse(params.id),
    routineId: routineIdParamSchema.parse(params.routineId),
  };
}

customerRoutinesRouter.post("/generate", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const customerId = customerIdParamSchema.parse((request.params as { id?: string }).id);
    const input = generateCustomerRoutineSchema.parse(request.body);
    response.status(201).json(await generateCustomerRoutine(session.userId, customerId, input));
  } catch (error) {
    next(error);
  }
});

customerRoutinesRouter.post("/", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const customerId = customerIdParamSchema.parse(
      (request.params as { id?: string }).id,
    );
    const input = createCustomerRoutineSchema.parse(request.body);
    const result = await createCustomerRoutine(session.userId, customerId, input);

    response.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

customerRoutinesRouter.patch("/:routineId", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const { customerId, routineId } = parseParams(request.params);
    const input = updateCustomerRoutineSchema.parse(request.body);
    const result = await updateCustomerRoutine(
      session.userId,
      customerId,
      routineId,
      input,
    );

    response.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

customerRoutinesRouter.post(
  "/:routineId/details",
  async (request, response, next) => {
    try {
      const session = await validateSessionToken(readSessionTokenFromRequest(request));
      const { customerId, routineId } = parseParams(request.params);
      const input = createRoutineDetailSchema.parse(request.body);
      const result = await createRoutineDetail(
        session.userId,
        customerId,
        routineId,
        input,
      );

      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  },
);

customerRoutinesRouter.patch(
  "/:routineId/details/:detailId",
  async (request, response, next) => {
    try {
      const session = await validateSessionToken(readSessionTokenFromRequest(request));
      const { customerId, routineId } = parseParams(request.params);
      const detailId = routineDetailIdParamSchema.parse(request.params.detailId);
      const input = updateRoutineDetailSchema.parse(request.body);
      const result = await updateRoutineDetail(
        session.userId,
        customerId,
        routineId,
        detailId,
        input,
      );

      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },
);

customerRoutinesRouter.delete(
  "/:routineId/details/:detailId",
  async (request, response, next) => {
    try {
      const session = await validateSessionToken(readSessionTokenFromRequest(request));
      const { customerId, routineId } = parseParams(request.params);
      const detailId = routineDetailIdParamSchema.parse(request.params.detailId);
      await deleteRoutineDetail(
        session.userId,
        customerId,
        routineId,
        detailId,
      );

      response.status(204).end();
    } catch (error) {
      next(error);
    }
  },
);

customerRoutinesRouter.use((_request, _response, next) => {
  next(new AppError(405, "METHOD_NOT_ALLOWED", "Método no permitido"));
});
