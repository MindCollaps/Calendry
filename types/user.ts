export interface WebUser {  
    id: string;
    username: string;
    email: string;
    avatarUrl?: string;
    isAdmin: boolean;
    loggedIn: boolean;
}