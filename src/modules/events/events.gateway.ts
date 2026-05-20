import {
  WebSocketGateway,
  SubscribeMessage,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
  Namespace,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Socket } from 'socket.io';

@WebSocketGateway({
  namespace: '/events',
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true,
  },
})
export class EventsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(EventsGateway.name);

  afterInit(server: Namespace) {
    this.logger.log('Events WebSocket gateway initialized');
  }

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('join_event')
  handleJoinEvent(
    @ConnectedSocket() client: Socket,
    @MessageBody() eventId: string,
  ): void {
    const room = `event_${eventId}`;
    client.join(room);
    this.logger.log(`Client ${client.id} joined event ${eventId}`);
  }

  @SubscribeMessage('leave_event')
  handleLeaveEvent(
    @ConnectedSocket() client: Socket,
    @MessageBody() eventId: string,
  ): void {
    const room = `event_${eventId}`;
    client.leave(room);
    this.logger.log(`Client ${client.id} left event ${eventId}`);
  }

  broadcastPicksUpdate(eventId: string, picks: any): void {
    const room = `event_${eventId}`;
    this.logger.log(`Broadcasting picks update for event ${eventId}`);
    // Using internal server reference - will be injected via dependency
  }

  broadcastEventStatus(
    eventId: string,
    status: string,
    scores?: { homeTeam?: number; awayTeam?: number },
  ): void {
    const room = `event_${eventId}`;
    this.logger.log(
      `Broadcasting status update for event ${eventId}: ${status}`,
    );
    // Using internal server reference - will be injected via dependency
  }
}
