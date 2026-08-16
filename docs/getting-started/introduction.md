# Introduction

Kavo turns your ORM entities into a full REST CRUD API. Define the entity once, add one decorator, and you get create, read, update, and delete. You also get filtering, sorting, pagination, nested includes, and field selection, with no hand-written controller methods.

Today Kavo supports NestJS as the framework, over TypeORM, Prisma, Mongoose, or MikroORM as the ORM. This guide uses Nest and TypeORM as its example stack. See [Prisma](/integrations/orms/prisma), [Mongoose](/integrations/orms/mongoose), and [MikroORM](/integrations/orms/mikroorm) for the equivalents.

<script setup lang="ts">
import StackPicker from "../.vitepress/theme/components/StackPicker.vue";
</script>

Pick your stack and jump straight to its wiring guide. Or keep reading: this page walks through Nest and TypeORM.

<StackPicker />
