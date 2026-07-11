import { runDoctor } from '../doctor.js';
import { resolveWorkspace } from '../workspace.js';
import { c, BANNER, hr } from '../utils.js';

export interface DoctorCommandOptions {
  json?: boolean;
  repair?: boolean;
}

export async function doctorCommand(options: DoctorCommandOptions = {}): Promise<void> {
  let report;
  try {
    report = runDoctor({ workspace: resolveWorkspace(), repair: options.repair === true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      console.log(JSON.stringify({ tool: 'mythos-doctor', error: message, exitCode: 2 }, null, 2));
    } else {
      console.error(`${c.red}✖ Doctor could not inspect this workspace: ${message}${c.reset}`);
    }
    process.exitCode = 2;
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(BANNER);
    console.log(`  ${c.cyan}${c.bold}Workspace Doctor${c.reset}`);
    console.log(`  ${c.dim}${report.workspace}${c.reset}`);
    console.log(hr());
    for (const check of report.checks) {
      const marker = check.status === 'pass'
        ? `${c.green}✔${c.reset}`
        : check.status === 'warn'
          ? `${c.yellow}⚠${c.reset}`
          : `${c.red}✖${c.reset}`;
      console.log(`  ${marker} ${c.bold}${check.label}${c.reset}`);
      console.log(`    ${c.dim}${check.detail}${c.reset}`);
    }
    console.log(hr());
    if (report.repaired > 0) {
      console.log(`  ${c.green}Recovered or cleaned ${report.repaired} transaction journal(s).${c.reset}`);
    }
    console.log(report.ok
      ? `  ${c.green}${c.bold}Workspace health checks passed.${c.reset}\n`
      : `  ${c.red}${c.bold}Workspace has health-check failures.${c.reset}\n`);
  }
  process.exitCode = report.exitCode;
}
