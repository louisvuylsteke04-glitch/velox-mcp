import { createVeloxHandler } from "@/src/server";

const handler = createVeloxHandler();

export { handler as GET, handler as POST, handler as DELETE };
