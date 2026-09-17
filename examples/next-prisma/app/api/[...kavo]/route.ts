import { createKavoHandler } from "@kavo/next";
import { kavo } from "../../../lib/kavo";
import "../../../entities/author/author.service";
import "../../../entities/book/book.service";

export const { GET, POST, PUT, PATCH, DELETE } = createKavoHandler(kavo);
