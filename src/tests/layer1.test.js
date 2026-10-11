import { parseCsv, csvToLeads, autoDetectMapping } from "../services/leads/csvParser.js";
import { normalizeLead } from "../services/leads/leadIntake.service.js";

export function runLayer1Tests() {
    const results = [];
    const assert = (name, condition) => {
        if (condition) {
            results.push({ name, passed: true });
        } else {
            results.push({ name, passed: false });
            console.error(`[Layer 1 Test Failed]: ${name}`);
        }
    };

    try {
        // --- 1. CSV & Delimiter Parsing Tests ---
        const standardCsv = `Email,Name,Company\nalice@example.com,Alice Walker,Acme Corp\nbob@example.com,Bob Stone,Beta LLC`;
        const parsedStandard = parseCsv(standardCsv);
        assert("Standard comma CSV parsed correctly", parsedStandard.length === 3 && parsedStandard[1][0] === "alice@example.com");

        const semicolonCsv = `Email;Name;Company\nalice@example.com;Alice Walker;Acme Corp\nbob@example.com;Bob Stone;Beta LLC`;
        const parsedSemicolon = parseCsv(semicolonCsv);
        assert("Excel semicolon CSV parsed correctly", parsedSemicolon.length === 3 && parsedSemicolon[1][1] === "Alice Walker");

        const tabCsv = `Email\tName\tCompany\nalice@example.com\tAlice Walker\tAcme Corp`;
        const parsedTab = parseCsv(tabCsv);
        assert("Excel TSV/Tab parsed correctly", parsedTab.length === 2 && parsedTab[1][2] === "Acme Corp");

        const quotedCsv = `"Email Address","Full Name","Notes"\n"lead@test.com","Doe, John","CEO, VP"`;
        const parsedQuoted = parseCsv(quotedCsv);
        assert("Quoted CSV with commas inside quotes handled", parsedQuoted.length === 2 && parsedQuoted[1][1] === "Doe, John" && parsedQuoted[1][2] === "CEO, VP");

        // --- 2. Auto-Detect Column Mapping Tests ---
        const headers = ["Work Email", "Contact Name", "Company Name", "Mobile", "Lead Priority", "Tags"];
        const mapping = autoDetectMapping(headers);
        assert("Auto-detect mapping found email column", mapping.email === 0);
        assert("Auto-detect mapping found name column", mapping.name === 1);
        assert("Auto-detect mapping found company column", mapping.company === 2);
        assert("Auto-detect mapping found phone column", mapping.phone === 3);
        assert("Auto-detect mapping found priority column", mapping.priority === 4);
        assert("Auto-detect mapping found tags column", mapping.tags === 5);

        // --- 3. CSV To Leads Conversion ---
        const sampleCsv = `Work Email,Contact Name,Mobile\njohn.doe@techcorp.com,John Doe,+1 (555) 234-5678`;
        const converted = csvToLeads(sampleCsv);
        assert("csvToLeads extracted lead rows with mapping", converted.leads.length === 1 && converted.leads[0].email === "john.doe@techcorp.com");

        // --- 4. Lead Normalization Tests ---
        const normalized = normalizeLead({
            email: "  MARK.SPENCER@RETAIL.COM  ",
            firstName: "Mark",
            lastName: "Spencer",
            phone: "+1 (800) 555-0199",
            priority: 90,
            tags: "enterprise, vip",
        });

        assert("Normalization lowercases and trims email", normalized.email === "mark.spencer@retail.com");
        assert("Normalization combines first and last name", normalized.name === "Mark Spencer");
        assert("Normalization cleans phone preserving +", normalized.phone === "+18005550199");
        assert("Normalization stores priority", normalized.priority === 90);
        assert("Normalization parses comma-separated tags into array", Array.isArray(normalized.tags) && normalized.tags.includes("enterprise") && normalized.tags.includes("vip"));
        assert("Normalization creates default email and voice consent", normalized.email_consent?.status === "GRANTED" && normalized.voice_consent?.status === "GRANTED");

        // --- 5. Validation Rules ---
        let errorThrown = false;
        try {
            normalizeLead({ name: "Missing Email Contact" });
        } catch (_) {
            errorThrown = true;
        }
        assert("Validation rejects record with missing email", errorThrown);

        let invalidEmailThrown = false;
        try {
            normalizeLead({ email: "invalid-email-string" });
        } catch (_) {
            invalidEmailThrown = true;
        }
        assert("Validation rejects invalid email format", invalidEmailThrown);

        console.log(`[Layer 1 Tests] Completed: ${results.filter(r => r.passed).length}/${results.length} passed.`);
    } catch (err) {
        console.error("[Layer 1 Tests] Error executing tests:", err);
    }

    return results;
}
