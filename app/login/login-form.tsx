"use client";

import { ArrowRight, Building2, Loader2, LockKeyhole, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useMemo, useState } from "react";
import { createClient } from "../../lib/supabase/client";
import { appUrl, isSupabaseConfigured } from "../../lib/supabase/config";

type AuthMode = "sign-in" | "sign-up";

export default function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("redirect") || "/review";
  const safeRedirectTo = redirectTo.startsWith("/") && !redirectTo.startsWith("//") ? redirectTo : "/review";
  const setupMissing = searchParams.get("setup") === "missing";
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isGoogleSubmitting, setIsGoogleSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const supabase = useMemo(() => (isSupabaseConfigured() ? createClient() : null), []);
  const browserOrigin = typeof window !== "undefined" ? window.location.origin : "";
  const configuredAppUrlPointsToLocalhost = appUrl.includes("localhost") || appUrl.includes("127.0.0.1");
  const browserIsLocalhost = browserOrigin.includes("localhost") || browserOrigin.includes("127.0.0.1");
  const authBaseUrl =
    appUrl && (!configuredAppUrlPointsToLocalhost || browserIsLocalhost) ? appUrl : browserOrigin;
  const callbackUrl = authBaseUrl
    ? `${authBaseUrl}/auth/callback?next=${encodeURIComponent(safeRedirectTo)}`
    : `/auth/callback?next=${encodeURIComponent(safeRedirectTo)}`;

  async function handleGoogleSignIn() {
    setError("");
    setMessage("");

    if (!supabase) {
      setError("Supabase is not configured yet. Add your Supabase URL and anon key to the environment.");
      return;
    }

    setIsGoogleSubmitting(true);

    const { error: googleError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: callbackUrl
      }
    });

    if (googleError) {
      setError(googleError.message);
      setIsGoogleSubmitting(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");

    if (!supabase) {
      setError("Supabase is not configured yet. Add your Supabase URL and anon key to the environment.");
      return;
    }

    setIsSubmitting(true);

    try {
      if (mode === "sign-in") {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password
        });

        if (signInError) throw signInError;
        router.replace(safeRedirectTo);
        router.refresh();
        return;
      }

      const { error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: callbackUrl
        }
      });

      if (signUpError) throw signUpError;
      setMessage("Account created. Check your email if confirmation is enabled, then sign in.");
      setMode("sign-in");
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : "Authentication failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="loginShell">
      <section className="loginCard">
        <Link className="landingBrand loginBrand" href="/">
          <span>
            <ShieldCheck size={22} />
          </span>
          <div>
            <strong>Builder Precheck</strong>
            <small>BCBC 2024 support</small>
          </div>
        </Link>

        <div className="loginIntro">
          <p className="eyebrow">Secure access</p>
          <h1>{mode === "sign-in" ? "Sign in to review plans." : "Create your builder account."}</h1>
          <p>Protect project files and keep plan reviews tied to your account.</p>
        </div>

        {setupMissing ? (
          <div className="loginNotice">
            <Building2 size={18} />
            <span>Supabase environment variables are missing in this environment.</span>
          </div>
        ) : null}

        <button
          className="googleAuthButton"
          disabled={isGoogleSubmitting || !supabase}
          type="button"
          onClick={handleGoogleSignIn}
        >
          {isGoogleSubmitting ? (
            <Loader2 className="spin" size={18} />
          ) : (
            <span className="googleMark" aria-hidden="true">
              G
            </span>
          )}
          Continue with Google
        </button>

        <div className="authDivider">
          <span>or use email</span>
        </div>

        <form className="authForm" onSubmit={handleSubmit}>
          <label>
            <span>Email</span>
            <input
              autoComplete="email"
              inputMode="email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="builder@example.com"
              required
              type="email"
              value={email}
            />
          </label>

          <label>
            <span>Password</span>
            <input
              autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              minLength={6}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="At least 6 characters"
              required
              type="password"
              value={password}
            />
          </label>

          {error ? <p className="errorText">{error}</p> : null}
          {message ? <p className="statusText">{message}</p> : null}

          <button className="landingPrimary authSubmit" disabled={isSubmitting || !supabase} type="submit">
            {isSubmitting ? <Loader2 className="spin" size={18} /> : <LockKeyhole size={18} />}
            {mode === "sign-in" ? "Sign in" : "Create account"}
            <ArrowRight size={18} />
          </button>
        </form>

        <button
          className="authSwitch"
          type="button"
          onClick={() => {
            setMode(mode === "sign-in" ? "sign-up" : "sign-in");
            setError("");
            setMessage("");
          }}
        >
          {mode === "sign-in" ? "Need an account? Create one" : "Already have an account? Sign in"}
        </button>
      </section>
    </main>
  );
}
