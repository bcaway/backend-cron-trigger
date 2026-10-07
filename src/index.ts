/**
 * BCAway Backend Cron Trigger — Cloudflare Worker
 * 
 * Provides sub-second precision cron dispatching to GitHub Actions REST API,
 * replacing GitHub's delayed/irregular internal cron scheduler.
 * 
 * Schedule rules:
 * - 11:00 AM UTC (Mon-Fri) -> Dispatches teacher_sync_peak.yml (boots 150-min 60s continuous loop)
 * - 11:10 AM - 1:20 PM UTC (Mon-Fri) -> Skips dispatch (peak continuous loop is actively running)
 * - All other times (every 10 minutes) -> Dispatches teacher_sync_offpeak.yml (single-shot check)
 */

export interface Env {
  /**
   * GitHub Personal Access Token (classic with 'repo' scope or fine-grained with 'actions:write')
   */
  GH_DISPATCH_TOKEN?: string;

  /**
   * Target GitHub repository in owner/repo format (Default: bcaway/backend-sync)
   */
  GITHUB_REPO?: string;

  /**
   * Target Git ref / branch to dispatch on (Default: main)
   */
  GITHUB_REF?: string;

  /**
   * Optional shared secret to protect manual HTTP /trigger endpoints
   */
  TRIGGER_AUTH_SECRET?: string;
}

export interface TimeContext {
  utcIso: string;
  utcDay: number; // 0 = Sun, 1 = Mon, ..., 5 = Fri, 6 = Sat
  utcHours: number;
  utcMinutes: number;
  easternTime: string;
  isWeekday: boolean;
  totalUtcMinutes: number;
  isPeakLaunchWindow: boolean;
  isPeakActiveWindow: boolean;
  shouldSkipBecausePeakActive: boolean;
}

export type PlannedAction = 
  | { type: "dispatch_peak"; workflow: string; reason: string }
  | { type: "skip_peak_active"; workflow: null; reason: string }
  | { type: "dispatch_offpeak"; workflow: string; reason: string };

const PEAK_WORKFLOW = "teacher_sync_peak.yml";
const OFFPEAK_WORKFLOW = "teacher_sync_offpeak.yml";
const DEFAULT_REPO = "bcaway/backend-sync";
const DEFAULT_REF = "main";

/**
 * Calculates current time context across UTC and US Eastern timezone.
 */
export function getTimeContext(date: Date = new Date()): TimeContext {
  const utcHours = date.getUTCHours();
  const utcMinutes = date.getUTCMinutes();
  const utcDay = date.getUTCDay();
  const isWeekday = utcDay >= 1 && utcDay <= 5;
  const totalUtcMinutes = utcHours * 60 + utcMinutes;

  // Peak window: 11:00 UTC (660m) to 13:30 UTC (810m)
  const isPeakLaunchWindow = isWeekday && totalUtcMinutes >= 660 && totalUtcMinutes < 670; // 11:00 - 11:09 UTC
  const isPeakActiveWindow = isWeekday && totalUtcMinutes >= 660 && totalUtcMinutes < 810; // 11:00 - 13:30 UTC
  const shouldSkipBecausePeakActive = isWeekday && totalUtcMinutes >= 670 && totalUtcMinutes < 810; // 11:10 - 13:29 UTC

  let easternTime = "";
  try {
    easternTime = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(date);
  } catch {
    easternTime = date.toISOString();
  }

  return {
    utcIso: date.toISOString(),
    utcDay,
    utcHours,
    utcMinutes,
    easternTime,
    isWeekday,
    totalUtcMinutes,
    isPeakLaunchWindow,
    isPeakActiveWindow,
    shouldSkipBecausePeakActive,
  };
}

/**
 * Evaluates which workflow action should be taken based on the schedule.
 */
export function evaluateScheduleAction(context: TimeContext): PlannedAction {
  if (context.isPeakLaunchWindow) {
    return {
      type: "dispatch_peak",
      workflow: PEAK_WORKFLOW,
      reason: `Weekday 11:00 UTC reached (${context.easternTime} ET). Starting 150-minute continuous peak runner.`,
    };
  }

  if (context.shouldSkipBecausePeakActive) {
    return {
      type: "skip_peak_active",
      workflow: null,
      reason: `Active weekday peak window (11:00-13:30 UTC). Peak continuous monitor is actively scraping every minute. Skipping off-peak run.`,
    };
  }

  return {
    type: "dispatch_offpeak",
    workflow: OFFPEAK_WORKFLOW,
    reason: `Off-peak schedule tick (${context.utcIso} | ${context.easternTime} ET). Running periodic single-shot sync.`,
  };
}

/**
 * Dispatches a GitHub Actions workflow via the GitHub REST API.
 */
export async function dispatchWorkflow(
  env: Env,
  workflow: string,
  inputs?: Record<string, string | boolean>
): Promise<{ success: boolean; status: number; message: string; details?: any }> {
  const token = env.GH_DISPATCH_TOKEN;
  if (!token) {
    return {
      success: false,
      status: 500,
      message: "Missing GH_DISPATCH_TOKEN secret in Cloudflare Worker environment.",
    };
  }

  const repo = env.GITHUB_REPO || DEFAULT_REPO;
  const ref = env.GITHUB_REF || DEFAULT_REF;
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`;

  const payload: { ref: string; inputs?: Record<string, string | boolean> } = { ref };
  if (inputs && Object.keys(inputs).length > 0) {
    payload.inputs = inputs;
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "BCAway-Cron-Trigger",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    // GitHub returns 204 No Content upon successful dispatch
    if (response.status === 204) {
      return {
        success: true,
        status: 204,
        message: `Successfully dispatched workflow '${workflow}' on repo '${repo}' (${ref}).`,
      };
    }

    const errorBody = await response.text();
    return {
      success: false,
      status: response.status,
      message: `GitHub API returned HTTP ${response.status} when dispatching '${workflow}'.`,
      details: errorBody,
    };
  } catch (error: any) {
    return {
      success: false,
      status: 500,
      message: `Failed to connect to GitHub API: ${error?.message || String(error)}`,
    };
  }
}

/**
 * Checks if request is authorized (when TRIGGER_AUTH_SECRET is set).
 */
function isAuthorized(request: Request, env: Env): boolean {
  if (!env.TRIGGER_AUTH_SECRET) {
    return true; // No secret configured -> open for manual invocation
  }

  const url = new URL(request.url);
  const keyParam = url.searchParams.get("key");
  if (keyParam === env.TRIGGER_AUTH_SECRET) {
    return true;
  }

  const authHeader = request.headers.get("Authorization");
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match && match[1] === env.TRIGGER_AUTH_SECRET) {
      return true;
    }
  }

  return false;
}

export default {
  /**
   * Cloudflare Cron Trigger Handler
   * Invoked automatically every 10 minutes by Cloudflare's edge scheduler.
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const scheduledTime = event.scheduledTime ? new Date(event.scheduledTime) : new Date();
    const timeCtx = getTimeContext(scheduledTime);
    const action = evaluateScheduleAction(timeCtx);

    console.log(`[CRON TICK] Time: ${timeCtx.utcIso} (${timeCtx.easternTime} ET)`);
    console.log(`[CRON TICK] Plan: ${action.type} -> ${action.reason}`);

    if (action.type === "skip_peak_active") {
      console.log(`[CRON TICK] Skipped: ${action.reason}`);
      return;
    }

    const result = await dispatchWorkflow(env, action.workflow);
    if (!result.success) {
      console.error(`[CRON ERROR] Dispatch failed: ${result.message}`, result.details);
    } else {
      console.log(`[CRON SUCCESS] ${result.message}`);
    }
  },

  /**
   * HTTP Request Handler
   * Provides health check, status monitoring, and manual dispatch endpoints.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // CORS preflight / simple headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check endpoint
    if (pathname === "/health") {
      return new Response(JSON.stringify({ status: "healthy", timestamp: new Date().toISOString() }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Manual /cron simulation endpoint (runs the exact scheduled() logic on-demand)
    if (pathname === "/cron") {
      if (!isAuthorized(request, env)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const timeCtx = getTimeContext();
      const action = evaluateScheduleAction(timeCtx);

      if (action.type === "skip_peak_active") {
        return new Response(
          JSON.stringify({
            executed: false,
            action: action.type,
            reason: action.reason,
            time: timeCtx,
          }),
          { headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }

      const result = await dispatchWorkflow(env, action.workflow);
      return new Response(
        JSON.stringify({
          executed: true,
          action: action.type,
          workflow: action.workflow,
          reason: action.reason,
          dispatchResult: result,
          time: timeCtx,
        }),
        {
          status: result.success ? 200 : 502,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        }
      );
    }

    // Manual /trigger endpoint (allows explicitly specifying 'peak' or 'offpeak' or 'auto')
    if (pathname === "/trigger") {
      if (!isAuthorized(request, env)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const requestedWorkflow = url.searchParams.get("workflow")?.toLowerCase();
      const force = url.searchParams.get("force") === "true";
      const timeCtx = getTimeContext();

      let targetWorkflow: string;
      let inputs: Record<string, string | boolean> = {};

      if (force) {
        inputs.force = true;
      }

      if (requestedWorkflow === "peak") {
        targetWorkflow = PEAK_WORKFLOW;
      } else if (requestedWorkflow === "offpeak") {
        targetWorkflow = OFFPEAK_WORKFLOW;
      } else {
        // Auto mode based on current schedule
        const action = evaluateScheduleAction(timeCtx);
        if (action.type === "skip_peak_active") {
          return new Response(
            JSON.stringify({
              executed: false,
              message: "Peak continuous runner is currently active. Use ?workflow=offpeak or ?workflow=peak to bypass auto-skip.",
              action,
              time: timeCtx,
            }),
            { headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }
        targetWorkflow = action.workflow;
      }

      const result = await dispatchWorkflow(env, targetWorkflow, inputs);
      return new Response(
        JSON.stringify({
          workflow: targetWorkflow,
          inputs,
          result,
          time: timeCtx,
        }),
        {
          status: result.success ? 200 : 502,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        }
      );
    }

    // Root status dashboard
    const timeCtx = getTimeContext();
    const plannedAction = evaluateScheduleAction(timeCtx);

    const statusReport = {
      service: "BCAway Backend Cron Trigger",
      status: "operational",
      version: "1.0.0",
      time: {
        utc: timeCtx.utcIso,
        eastern: timeCtx.easternTime,
        weekday: timeCtx.isWeekday,
        peakActiveNow: timeCtx.isPeakActiveWindow,
      },
      nextCronAction: {
        type: plannedAction.type,
        workflow: plannedAction.workflow,
        explanation: plannedAction.reason,
      },
      configuration: {
        targetRepo: env.GITHUB_REPO || DEFAULT_REPO,
        targetRef: env.GITHUB_REF || DEFAULT_REF,
        hasGithubToken: Boolean(env.GH_DISPATCH_TOKEN),
        hasTriggerAuthSecret: Boolean(env.TRIGGER_AUTH_SECRET),
        peakWorkflow: PEAK_WORKFLOW,
        offPeakWorkflow: OFFPEAK_WORKFLOW,
      },
      endpoints: {
        status: "GET /",
        health: "GET /health",
        manualTrigger: "GET|POST /trigger?workflow=peak|offpeak[&force=true]",
        cronSimulate: "POST /cron",
      },
    };

    return new Response(JSON.stringify(statusReport, null, 2), {
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  },
};
