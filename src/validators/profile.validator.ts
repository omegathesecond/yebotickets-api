import { body, ValidationChain } from "express-validator";
import type { Request } from "express";
import { validateParams } from "@omevision/product-admin-boundary";
import { assertValidRequest } from "../middleware/validate.middleware";
import { ApiError } from "../middleware/error.middleware";

const nullableText = (title: string, extra: Record<string, unknown> = {}) => ({
  type: ["string", "null"],
  title,
  ...extra,
});
const object = (properties: Record<string, any>, title: string) => ({
  type: "object",
  title,
  properties,
  additionalProperties: false,
});
/** The existing nested profile contract, used by product routes, service and native forms. */
export const profileFields = {
  name: { type: "string", title: "Full name", minLength: 2, maxLength: 100 },
  email: nullableText("Email", { format: "email" }),
  organizerProfile: object(
    {
      companyName: nullableText("Company name", {
        minLength: 2,
        maxLength: 100,
      }),
      description: nullableText("Company description", {
        minLength: 10,
        maxLength: 1000,
      }),
      website: nullableText("Website", { format: "uri" }),
      socialMedia: object(
        Object.fromEntries(
          ["facebook", "twitter", "instagram", "linkedin"].map((name) => [
            name,
            nullableText(name[0].toUpperCase() + name.slice(1), {
              format: "uri",
            }),
          ]),
        ),
        "Social links",
      ),
      address: object(
        Object.fromEntries(
          ["street", "city", "state", "zipCode", "country"].map((name) => [
            name,
            nullableText(
              (
                {
                  street: "Street",
                  city: "City or town",
                  state: "Region",
                  zipCode: "Postal code",
                  country: "Country",
                } as Record<string, string>
              )[name],
              { minLength: 1 },
            ),
          ]),
        ),
        "Address",
      ),
    },
    "Company profile",
  ),
};
const profileSchema = object(profileFields, "Profile changes");
const valueValidators: ValidationChain[] = [];
function formats(properties: Record<string, any>, prefix = "") {
  for (const [name, spec] of Object.entries(properties)) {
    const path = prefix + name;
    if (spec.format) {
      const rule = body(path).optional({ nullable: true });
      valueValidators.push(
        spec.format === "email"
          ? rule.isEmail().withMessage("Please provide a valid email address")
          : rule.isURL().withMessage("Please provide a valid URL for " + path),
      );
    }
    if (spec.properties) formats(spec.properties, path + ".");
  }
}
formats(profileFields);
const hasValue = (value: unknown): boolean =>
  value === null ||
  typeof value !== "object" ||
  Object.values(value as object).some(hasValue);
export async function validateProfileInput(input: unknown) {
  const result = validateParams(profileSchema, input);
  if (!result.ok)
    throw new ApiError(
      "Invalid profile fields: " + result.errors.join("; "),
      400,
    );
  if (!hasValue(input))
    throw new ApiError("Choose at least one profile field to change", 400);
  const checkText = (value: unknown) => {
    if (typeof value === "string" && !value.trim())
      throw new ApiError(
        "Profile values cannot be blank; use Clear this value to remove an optional field",
        400,
      );
    if (value && typeof value === "object")
      Object.values(value).forEach(checkText);
  };
  checkText(input);
  await assertValidRequest(valueValidators, { body: input } as Request);
}
export const profileValidator = [
  body().custom(async (value) => {
    await validateProfileInput(value);
    return true;
  }),
];
