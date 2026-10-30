import { Router } from "express";
import { z } from "zod";
import { readSessionTokenFromRequest, validateSessionToken } from "../auth/auth.service.js";
import { enrollmentCollectionSchema, enrollmentFeeSchema, enrollmentReviewSchema } from "./enrollment.schemas.js";
import { collectEnrollment, getEnrollment, reviewEnrollment, setEnrollmentFee } from "./enrollment.service.js";

export const enrollmentRouter = Router();
enrollmentRouter.get("/settings", async (req, res, next) => {
  try { const session = await validateSessionToken(readSessionTokenFromRequest(req));
    res.json(await getEnrollment(session.userId)); } catch (error) { next(error); }
});
enrollmentRouter.put("/settings", async (req, res, next) => {
  try { const session = await validateSessionToken(readSessionTokenFromRequest(req));
    const { fee } = z.object({ fee: enrollmentFeeSchema }).strict().parse(req.body);
    res.json(await setEnrollmentFee(session.userId, fee)); } catch (error) { next(error); }
});
enrollmentRouter.get("/:customerId", async (req, res, next) => {
  try { const session = await validateSessionToken(readSessionTokenFromRequest(req));
    res.json(await getEnrollment(session.userId, z.uuid().parse(req.params.customerId))); } catch (error) { next(error); }
});
enrollmentRouter.post("/:customerId/review", async (req, res, next) => {
  try { const session = await validateSessionToken(readSessionTokenFromRequest(req));
    res.json(await reviewEnrollment(session.userId, z.uuid().parse(req.params.customerId), enrollmentReviewSchema.parse(req.body)));
  } catch (error) { next(error); }
});
enrollmentRouter.post("/:customerId/collect", async (req, res, next) => {
  try { const session = await validateSessionToken(readSessionTokenFromRequest(req));
    res.status(201).json(await collectEnrollment(session.userId, z.uuid().parse(req.params.customerId), enrollmentCollectionSchema.parse(req.body)));
  } catch (error) { next(error); }
});
