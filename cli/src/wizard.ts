import { promptText, promptSelect, promptConfirm } from "./prompt.js";
import { CLOUD_PROVIDERS, IAC_TOOLS, serviceNew } from "./services.js";
import { init } from "./init.js";

const ACTIONS = ["New service", "New project"] as const;
const CI_PROVIDERS = ["none", "github", "gitlab"] as const;

export async function runWizard(root: string): Promise<number> {
  if (!process.stdin.isTTY) {
    console.error("✖ Wizard requires an interactive terminal (TTY).");
    return 1;
  }

  console.log("base-ai wizard — interactive project & service setup\n");

  const action = await promptSelect("What do you want to create?", ACTIONS);

  if (action === "New service") {
    return wizardServiceNew(root);
  }
  return wizardInit();
}

async function wizardServiceNew(root: string): Promise<number> {
  const name = await promptText("Service name (lowercase, hyphens)");
  if (!name) { console.error("✖ Service name is required."); return 1; }

  const repo = await promptText("Git remote URL (e.g. git@github.com:org/repo.git)");
  if (!repo) { console.error("✖ Repo URL is required."); return 1; }

  const cloud = await promptSelect("Cloud provider:", CLOUD_PROVIDERS);
  const iac = await promptSelect("Infrastructure as Code tool:", IAC_TOOLS);

  console.log("\n--- Summary ---");
  console.log(`  Service:  ${name}`);
  console.log(`  Repo:     ${repo}`);
  console.log(`  Cloud:    ${cloud}`);
  console.log(`  IaC:      ${iac}`);
  console.log("");

  const proceed = await promptConfirm("Proceed?");
  if (!proceed) { console.log("Cancelled."); return 0; }

  const dest = serviceNew(root, name, repo, { cloud, iac });
  console.log(`\n✔ Service created at ${dest}`);
  return 0;
}

async function wizardInit(): Promise<number> {
  const dir = await promptText("Project directory name");
  if (!dir) { console.error("✖ Directory name is required."); return 1; }

  const ci = await promptSelect("CI/CD provider:", CI_PROVIDERS);

  console.log("\n--- Summary ---");
  console.log(`  Directory: ${dir}`);
  console.log(`  CI/CD:     ${ci}`);
  console.log("");

  const proceed = await promptConfirm("Proceed?");
  if (!proceed) { console.log("Cancelled."); return 0; }

  const dest = init(dir, ci === "none" ? undefined : ci);
  console.log(`\n✔ Project created at ${dest}`);
  return 0;
}
