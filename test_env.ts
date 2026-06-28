if (!Deno.env.get("STRIPE_SECRET_KEY"))
  Deno.env.set("STRIPE_SECRET_KEY", "sk_test_mock_key");
if (!Deno.env.get("RESEND_API_KEY"))
  Deno.env.set("RESEND_API_KEY", "re_test_mock_key");
if (!Deno.env.get("EMAIL_TOKEN_SECRET"))
  Deno.env.set("EMAIL_TOKEN_SECRET", "test_secret");
if (!Deno.env.get("COOKIE_SECRET"))
  Deno.env.set("COOKIE_SECRET", "test_cookie_secret");
if (!Deno.env.get("KEY_WRAP_SECRET"))
  Deno.env.set("KEY_WRAP_SECRET", "test_key_wrap_secret");
if (!Deno.env.get("DING_ORG_PK"))
  Deno.env.set("DING_ORG_PK", "75c7c44d3e83efc8c132a6fc5ff9334fc2559c787f6608fec340ab25a270221c");
if (!Deno.env.get("DING_ORG_SK")) {
  Deno.env.set(
    "DING_ORG_SK",
    JSON.stringify({
      kty: "OKP",
      crv: "Ed25519",
      d: "NABeVHyPQWWdaQvpli3ixdKtUYox7vboFd4U83kF2fQ",
      x: "dcfETT6D78jBMqb8X_kzT8JVnHh_Zgj-w0CrJaJwIhw",
      key_ops: ["sign"],
      ext: true,
    }),
  );
}
