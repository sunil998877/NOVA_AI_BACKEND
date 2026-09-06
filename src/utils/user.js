export const toPublicUser = (user) => {
    const obj = { ...user };
    delete obj.passwordHash;
    delete obj.passwordResetTokenHash;
    delete obj.passwordResetExpires;
    return obj;
};
