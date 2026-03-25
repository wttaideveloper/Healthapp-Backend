import { NotFoundError } from "@core/errors/http-errors";
import { UserId } from "./user.domain";
import { UserRepository } from "./user.repo";

export function createUserService(deps: {
    userRepo: UserRepository;
}) {
    return {
        async getUser(id: UserId) {
            const user = await deps.userRepo.findById(id);
            if (!user) {
                throw new NotFoundError("User not found");
            }
            return user;
        },
    };
}