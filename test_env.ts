if (!Deno.env.get("STRIPE_SECRET_KEY"))
  Deno.env.set("STRIPE_SECRET_KEY", "sk_test_mock_key");
if (!Deno.env.get("RESEND_API_KEY"))
  Deno.env.set("RESEND_API_KEY", "re_test_mock_key");
if (!Deno.env.get("EMAIL_TOKEN_SECRET"))
  Deno.env.set("EMAIL_TOKEN_SECRET", "test_secret");
