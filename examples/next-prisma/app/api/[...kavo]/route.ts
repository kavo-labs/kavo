import { createKavoHandler } from "@kavo/next";
import { authors, books } from "../../../src/kavo";

export const { GET, POST, PUT, PATCH, DELETE } = createKavoHandler({ authors, books });
