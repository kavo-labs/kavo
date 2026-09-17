import { createKavoHandler } from "@kavo/next";
import { kavo } from "../../../lib/kavo";

export const { GET, POST, PUT, PATCH, DELETE } = createKavoHandler(kavo);
