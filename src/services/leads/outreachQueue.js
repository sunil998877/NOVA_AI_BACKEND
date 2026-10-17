import { prepareCompanyOutreach } from "../ase/leadEmailDrafter.service.js";
import { aseScheduler } from "../ase/scheduler.service.js";

const LIMIT = 2;
const pending = [];
let active = 0;

function drain() {
    while (active < LIMIT && pending.length > 0) {
        const lead = pending.shift();
        active += 1;
        prepareCompanyOutreach(lead)
            .catch((error) => {
                console.error("Company analysis and email draft failed:", error.message);
            })
            .finally(() => {
                active -= 1;
                aseScheduler.kick();
                drain();
            });
    }
}

export function enqueueCompanyOutreach(lead) {
    if (process.env.ASE_SKIP_OUTREACH === "1") return;
    pending.push(lead);
    drain();
}
