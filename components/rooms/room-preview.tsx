import { RoomMembershipButton } from "@/components/room-membership-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { RoomPreview as RoomPreviewData } from "@/lib/rooms/discovery";
import { toViewerMembership } from "@/lib/rooms/discovery";
import Link from "next/link";

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function formatDate(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : dateFormat.format(date);
}

type RoomPreviewProps = {
  room: RoomPreviewData;
  backPath: string;
};

/**
 * Preview detail for one public room (PR 17): enough to decide — goal,
 * subject, exam, language, size, age — with no member identities, only the
 * count. Join delegates to the existing membership endpoint through
 * `RoomMembershipButton`; a caller who already belongs (or owns) the room
 * gets "Open room" instead. The back link keeps the originating filters.
 */
export function RoomPreview({ room, backPath }: RoomPreviewProps) {
  const created = formatDate(room.created_at);
  const isFull = room.member_count >= room.capacity;
  const isClosed = room.status !== "open";
  const isMember = room.is_member;
  const seatLabel = `${room.member_count} of ${room.capacity} ${
    room.capacity === 1 ? "seat" : "seats"
  } taken`;

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <Link
        href={backPath}
        className="text-sm text-muted-foreground underline-offset-4 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring w-fit"
      >
        ← Back to results
      </Link>

      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>Public</Badge>
          <Badge variant={isClosed ? "secondary" : "default"}>
            {isClosed ? "Closed" : "Open"}
          </Badge>
          {isFull && <Badge variant="secondary">Full</Badge>}
        </div>
        <h1 className="text-2xl font-semibold">{room.name}</h1>
        <div className="flex flex-wrap gap-2">
          {room.exam_track && <Badge variant="outline">{room.exam_track}</Badge>}
          {room.subject && <Badge variant="outline">{room.subject}</Badge>}
          {room.language && <Badge variant="outline">{room.language}</Badge>}
        </div>
      </header>

      {room.shared_goal && (
        <p className="text-sm text-muted-foreground">{room.shared_goal}</p>
      )}

      <dl className="grid grid-cols-1 gap-3 rounded-lg border p-4 text-sm sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <dt className="text-muted-foreground">Seats</dt>
          <dd>{seatLabel}</dd>
        </div>
        {created && (
          <div className="flex flex-col gap-1">
            <dt className="text-muted-foreground">Created</dt>
            <dd>
              <time dateTime={room.created_at}>{created}</time>
            </dd>
          </div>
        )}
      </dl>

      <div className="flex flex-col gap-3">
        {isMember && (
          <Button asChild className="w-fit">
            <Link href={`/rooms/${room.id}`}>Open room</Link>
          </Button>
        )}
        <RoomMembershipButton
          roomId={room.id}
          roomName={room.name}
          viewerMembership={toViewerMembership(room.viewer_role)}
          isFull={isFull}
          isClosed={isClosed}
        />
      </div>
    </section>
  );
}
