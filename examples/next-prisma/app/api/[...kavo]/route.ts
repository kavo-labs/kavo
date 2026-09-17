import { createKavoHandler } from "@kavo/next";
import { authors } from "../../../entities/author/author.service";
import { books } from "../../../entities/book/book.service";

export const { GET, POST, PUT, PATCH, DELETE } = createKavoHandler({ authors, books });
