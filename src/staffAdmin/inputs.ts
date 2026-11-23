import type { Request } from "express";
import type { ValidationChain } from "express-validator";
import { assertValidRequest } from "../middleware/validate.middleware";
import { ApiError } from "../middleware/error.middleware";
import {
  createEventValidator,
  updateEventValidator,
} from "../validators/event.validator";
import {
  createTicketTypeValidator,
  updateTicketTypeValidator,
  generateTicketsValidator,
} from "../validators/ticket.validator";

const validators: Record<string, ValidationChain[]> = {
  admin_create_event: createEventValidator,
  admin_update_event: updateEventValidator,
  admin_create_ticket_type: createTicketTypeValidator,
  admin_update_ticket_type: updateTicketTypeValidator,
  admin_generate_inventory: generateTicketsValidator,
};

/** Reuse product request validation without manufacturing a product identity. */
export const operationInput = (parameters: Record<string, any>) => {
  const { id, eventId, organizerId, reason, ...input } = parameters;
  return input;
};
export async function validateOperationInput(
  name: string,
  parameters: Record<string, any>,
) {
  if (
    ["admin_update_event", "admin_update_ticket_type"].includes(name) &&
    !Object.keys(operationInput(parameters)).length
  )
    throw new ApiError("Choose at least one field to change", 400);
  if (validators[name]) {
    await assertValidRequest(validators[name], {
      body: operationInput(parameters),
    } as Request);
  }
}
