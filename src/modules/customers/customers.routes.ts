import { Router } from "express";

import { AppError } from "../../errors/app-error.js";
import {
  readSessionTokenFromRequest,
  validateSessionToken,
} from "../auth/auth.service.js";
import { customerIdParamSchema } from "./customers.schemas.js";
import {
  createCustomer,
  getCustomerById,
  listCustomers,
  updateCustomer,
  updateCustomerStatus,
} from "./customers.service.js";

export const customersRouter = Router();

customersRouter.get("/", async (request, response, next) => {
  try {
    const token = readSessionTokenFromRequest(request);
    const session = await validateSessionToken(token);
    const customers = await listCustomers(
      session.userId,
      request.query,
    );

    response.status(200).json(customers);
  } catch (error) {
    next(error);
  }
});

customersRouter.get(
  "/:id",
  async (request, response, next) => {
    try {
      const token = readSessionTokenFromRequest(request);
      const session = await validateSessionToken(token);
      const customerId = customerIdParamSchema.parse(
        request.params.id,
      );
      const customer = await getCustomerById(
        session.userId,
        customerId,
      );

      response.status(200).json(customer);
    } catch (error) {
      next(error);
    }
  },
);

customersRouter.post("/", async (request, response, next) => {
  try {
    const token = readSessionTokenFromRequest(request);
    const session = await validateSessionToken(token);
    const customer = await createCustomer(
      session.userId,
      request.body,
    );

    response.status(201).json(customer);
  } catch (error) {
    next(error);
  }
});

customersRouter.patch(
  "/:id",
  async (request, response, next) => {
    try {
      const token = readSessionTokenFromRequest(request);
      const session = await validateSessionToken(token);
      const customerId = customerIdParamSchema.parse(
        request.params.id,
      );
      const customer = await updateCustomer(
        session.userId,
        customerId,
        request.body,
      );

      response.status(200).json(customer);
    } catch (error) {
      next(error);
    }
  },
);

customersRouter.patch(
  "/:id/status",
  async (request, response, next) => {
    try {
      const token = readSessionTokenFromRequest(request);
      const session = await validateSessionToken(token);
      const customerId = customerIdParamSchema.parse(
        request.params.id,
      );
      const customer = await updateCustomerStatus(
        session.userId,
        customerId,
        request.body,
      );

      response.status(200).json(customer);
    } catch (error) {
      next(error);
    }
  },
);

customersRouter.use((_request, _response, next) => {
  next(
    new AppError(
      405,
      "METHOD_NOT_ALLOWED",
      "Método no permitido",
    ),
  );
});
