import { Router } from "express";

import { AppError } from "../../errors/app-error.js";
import {
  readSessionTokenFromRequest,
  validateSessionToken,
} from "../auth/auth.service.js";
import { dashboardOverviewQuerySchema } from "./dashboard.schemas.js";
import { getDashboardOverview } from "./dashboard.service.js";

export const dashboardRouter = Router();

dashboardRouter.get(
  "/overview",
  async (request, response, next) => {
    try {
      const query = dashboardOverviewQuerySchema.parse(
        request.query,
      );
      const token = readSessionTokenFromRequest(request);
      const session = await validateSessionToken(token);
      const overview = await getDashboardOverview(
        session.userId,
        query,
      );

      response.status(200).json(overview);
    } catch (error) {
      next(error);
    }
  },
);

dashboardRouter.use((_request, _response, next) => {
  next(
    new AppError(
      405,
      "METHOD_NOT_ALLOWED",
      "Método no permitido",
    ),
  );
});
