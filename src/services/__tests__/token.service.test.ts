import jwt from "jsonwebtoken";
import {
  generateAuthTokens,
  verifyAccessToken,
  verifyRefreshToken,
} from "../token.service";

const previous = {
  access: process.env.JWT_SECRET,
  refresh: process.env.JWT_REFRESH_SECRET,
};
beforeEach(() => {
  process.env.JWT_SECRET = "local-access-secret";
  process.env.JWT_REFRESH_SECRET = "local-refresh-secret";
});
afterAll(() => {
  for (const [key, value] of [
    ["JWT_SECRET", previous.access],
    ["JWT_REFRESH_SECRET", previous.refresh],
  ]) {
    if (value === undefined) delete process.env[key!];
    else process.env[key!] = value;
  }
});
it("requires separate configured secrets without a hardcoded or cross-secret fallback", () => {
  delete process.env.JWT_SECRET;
  expect(() => generateAuthTokens("owner", "organizer", 0)).toThrow(
    "JWT_SECRET",
  );
  expect(() => verifyAccessToken("invalid")).toThrow("JWT_SECRET");
  process.env.JWT_SECRET = "local-access-secret";
  delete process.env.JWT_REFRESH_SECRET;
  expect(() => generateAuthTokens("owner", "organizer", 0)).toThrow(
    "JWT_REFRESH_SECRET",
  );
  expect(() => verifyRefreshToken("invalid")).toThrow("JWT_REFRESH_SECRET");
});
it("carries exact source session versions and keeps token purposes separate", () => {
  const tokens = generateAuthTokens("owner", "organizer", 7);
  expect(verifyAccessToken(tokens.token)).toEqual({
    id: "owner",
    authVersion: 7,
  });
  expect(verifyRefreshToken(tokens.refreshToken)).toMatchObject({
    id: "owner",
    authVersion: 7,
    type: "refresh",
  });
  expect(() => verifyAccessToken(tokens.refreshToken)).toThrow();
  expect(() => verifyRefreshToken(tokens.token)).toThrow();
});
it.each([undefined, -1, 1.2, "0", null])(
  "rejects missing or invalid session version %p without compatibility aliases",
  (authVersion) => {
    const token = jwt.sign(
      { id: "owner", role: "organizer", type: "access", authVersion },
      process.env.JWT_SECRET!,
    );
    expect(() => verifyAccessToken(token)).toThrow("invalid session");
    const refresh = jwt.sign(
      { id: "owner", role: "organizer", type: "refresh", authVersion },
      process.env.JWT_REFRESH_SECRET!,
    );
    expect(() => verifyRefreshToken(refresh)).toThrow("Invalid refresh token");
  },
);
it("rejects legacy token shapes and invalid source versions", () => {
  expect(() =>
    verifyAccessToken(
      jwt.sign({ id: "owner", role: "organizer" }, process.env.JWT_SECRET!),
    ),
  ).toThrow();
  expect(() => generateAuthTokens("owner", "organizer", -1)).toThrow("version");
});
