# Introduction

Kavo turns your ORM entities into a full REST CRUD API. Define the entity once, add one decorator, and you get create, read, update, delete, filtering, sorting, pagination, nested includes, and field selection — with no hand-written controller methods.

Today Kavo supports NestJS as the framework, over TypeORM, Prisma, Mongoose, or MikroORM as the ORM. This guide uses Nest + TypeORM as its example stack; see [Prisma](/integrations/orms/prisma), [Mongoose](/integrations/orms/mongoose), and [MikroORM](/integrations/orms/mikroorm) for the equivalents.

<script setup lang="ts">
import StackPicker from "../.vitepress/theme/components/StackPicker.vue";
</script>

Pick your stack and jump straight to its wiring guide, or keep reading — this page walks through Nest + TypeORM.

<StackPicker />
