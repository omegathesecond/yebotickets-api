import { OAuth2Client } from "google-auth-library";
import { workloadAudience } from "@omevision/product-admin-boundary";
import { verifyCorporateWorkload } from "./workloadIdentity";
const email = "fixture-ceo@fixture-project.iam.gserviceaccount.com";
const assertion = {
  iss: "ceo-dashboard",
  sub: "staff:reviewer",
  product: "yebotickets",
  action: "dashboard:GET:/capabilities",
  iat: 1,
  exp: 61,
};
const req = (value: any = assertion) =>
  ({
    get: (name: string) =>
      name === "Authorization"
        ? "Bearer fixture-google-id-token"
        : Buffer.from(JSON.stringify(value)).toString("base64url"),
  }) as any;
let verify: jest.SpyInstance;
beforeEach(() => {
  process.env.CEO_DASHBOARD_SERVICE_ACCOUNT = email;
  process.env.CEO_DASHBOARD_AUDIENCE = "https://api.yebotickets.com";
  verify = jest
    .spyOn(OAuth2Client.prototype, "verifyIdToken")
    .mockResolvedValue({
      getPayload: () => ({ email, email_verified: true }),
    } as any);
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.CEO_DASHBOARD_SERVICE_ACCOUNT;
  delete process.env.CEO_DASHBOARD_AUDIENCE;
  delete process.env.K_SERVICE;
});
it("binds the existing workload caller token to every asserted staff field", async () => {
  await expect(verifyCorporateWorkload(req())).resolves.toEqual(assertion);
  expect(verify).toHaveBeenCalledWith({
    idToken: "fixture-google-id-token",
    audience: workloadAudience("https://api.yebotickets.com", assertion),
  });
  expect(
    workloadAudience("https://api.yebotickets.com", {
      ...assertion,
      sub: "staff:other",
    }),
  ).not.toBe(workloadAudience("https://api.yebotickets.com", assertion));
});
it("rejects the wrong caller, unverified email and provider verification failures", async () => {
  for (const payload of [
    { email: "other@fixture.test", email_verified: true },
    { email, email_verified: false },
  ]) {
    verify.mockResolvedValueOnce({ getPayload: () => payload } as any);
    await expect(verifyCorporateWorkload(req())).rejects.toMatchObject({
      statusCode: 401,
    });
  }
  verify.mockRejectedValueOnce(new Error("Verification unavailable"));
  await expect(verifyCorporateWorkload(req())).rejects.toMatchObject({
    statusCode: 401,
  });
});
it("fails visibly for absent identity configuration or malformed assertions", async () => {
  await expect(
    verifyCorporateWorkload({ get: () => undefined } as any),
  ).rejects.toMatchObject({ statusCode: 401 });
  delete process.env.CEO_DASHBOARD_SERVICE_ACCOUNT;
  await expect(verifyCorporateWorkload(req())).rejects.toMatchObject({
    statusCode: 503,
  });
  expect(verify).not.toHaveBeenCalled();
});
it("requires the dev audience on the actual dev service instead of accepting production assertions", async () => {
  process.env.K_SERVICE = "yebotickets-api-dev";
  await expect(verifyCorporateWorkload(req())).rejects.toMatchObject({
    statusCode: 503,
  });
  expect(verify).not.toHaveBeenCalled();
  process.env.CEO_DASHBOARD_AUDIENCE = "https://dev-api.yebotickets.com";
  await expect(verifyCorporateWorkload(req())).resolves.toEqual(assertion);
  expect(verify).toHaveBeenCalledWith({
    idToken: "fixture-google-id-token",
    audience: workloadAudience("https://dev-api.yebotickets.com", assertion),
  });
});
