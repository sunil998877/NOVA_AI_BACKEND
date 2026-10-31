import { asyncHandler } from "../../utils/asyncHandler.js";
import { listCountries, parsePhoneInput } from "../../services/leads/phoneNumber.service.js";

export const listPhoneCountries = asyncHandler(async (_req, res) => {
    return res.status(200).json({ data: listCountries() });
});

export const parseLeadPhone = asyncHandler(async (req, res) => {
    const parsed = parsePhoneInput(req.body?.phone ?? req.query?.phone ?? "", {
        defaultCountry: req.body?.defaultCountry || req.query?.defaultCountry,
        explicitCountry: req.body?.explicitCountry || req.body?.country || req.query?.country,
        confirmConflict: req.body?.confirmConflict === true,
    });
    return res.status(200).json({ data: parsed });
});
