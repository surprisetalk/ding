if (!Deno.env.get("STRIPE_SECRET_KEY"))
  Deno.env.set("STRIPE_SECRET_KEY", "sk_test_mock_key");
if (!Deno.env.get("SENDGRID_API_KEY"))
  Deno.env.set("SENDGRID_API_KEY", "SG.test_mock_key");
if (!Deno.env.get("EMAIL_TOKEN_SECRET"))
  Deno.env.set("EMAIL_TOKEN_SECRET", "test_secret");
