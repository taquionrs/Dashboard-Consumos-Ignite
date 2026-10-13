import { headers } from "next/headers";
import AnunciosView from "../../components/AnunciosView";
import { readSession } from "@/lib/access";

export default function AnunciosPage() {
  return <AnunciosView session={readSession(headers())} />;
}
