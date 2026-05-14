import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { supabaseAnonKey, supabaseUrl } from "./lib/supabase/config";

const protectedPagePaths = ["/review"];
const protectedApiPaths = ["/api/sheet-splitter", "/api/saved-pages"];

function isProtectedPage(pathname: string) {
  return protectedPagePaths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

function isProtectedApi(pathname: string) {
  return protectedApiPaths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isLoginPage = pathname === "/login";
  const protectsPage = isProtectedPage(pathname);
  const protectsApi = isProtectedApi(pathname);

  if (!protectsPage && !protectsApi && !isLoginPage) {
    return NextResponse.next();
  }

  if (!supabaseUrl || !supabaseAnonKey) {
    if (protectsApi) {
      return NextResponse.json({ error: "Supabase auth is not configured." }, { status: 500 });
    }

    if (isLoginPage) {
      return NextResponse.next();
    }

    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("setup", "missing");
    if (protectsPage) loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  let supabaseResponse = NextResponse.next({
    request
  });

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        supabaseResponse = NextResponse.next({
          request
        });
        cookiesToSet.forEach(({ name, value, options }) => {
          supabaseResponse.cookies.set(name, value, options);
        });
      }
    }
  });

  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user && protectsApi) {
    return NextResponse.json({ error: "Please sign in before running a plan review." }, { status: 401 });
  }

  if (!user && protectsPage) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (user && pathname === "/login") {
    const reviewUrl = request.nextUrl.clone();
    reviewUrl.pathname = "/review";
    reviewUrl.search = "";
    return NextResponse.redirect(reviewUrl);
  }

  return supabaseResponse;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"]
};
