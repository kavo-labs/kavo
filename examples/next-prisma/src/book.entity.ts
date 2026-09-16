import type { Author } from "./author.entity";

// Marker class — see author.entity.ts.
export class Book {
  id!: number;
  title!: string;
  published!: boolean;
  authorId!: number | null;
  author!: Author | null;
}

// See author.entity.ts.
Object.defineProperty(Book, "name", { value: "Book" });
