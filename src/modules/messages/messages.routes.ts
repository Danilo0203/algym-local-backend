import { Router } from "express";

import { readSessionTokenFromRequest, validateSessionToken } from "../auth/auth.service.js";
import { createMessageSchema, messageIdSchema, messageListQuerySchema, updateMessageSchema } from "./messages.schemas.js";
import { createMessage, deleteMessage, listMessages, updateMessage } from "./messages.service.js";

export const messagesRouter = Router();

messagesRouter.get("/", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const query = messageListQuerySchema.parse(request.query);
    response.status(200).json(await listMessages(session.userId, query.include_inactive));
  } catch (error) { next(error); }
});

messagesRouter.post("/", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const input = createMessageSchema.parse(request.body);
    response.status(201).json(await createMessage(session.userId, input));
  } catch (error) { next(error); }
});

messagesRouter.patch("/:id", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const id = messageIdSchema.parse(request.params.id);
    const input = updateMessageSchema.parse(request.body);
    response.status(200).json(await updateMessage(session.userId, id, input));
  } catch (error) { next(error); }
});

messagesRouter.delete("/:id", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const id = messageIdSchema.parse(request.params.id);
    await deleteMessage(session.userId, id);
    response.status(204).end();
  } catch (error) { next(error); }
});
